#!/usr/bin/env node
// AgentFlow CLI（af）— 把 DeepSeek Flow 的「Markdown 唯一事实来源 + 确定性布尔门」
// 带给任何终端编码代理（ZCode / Claude Code / Codex CLI / 裸 shell）。
//
// 与 dsh 插件的关系：lib/ 里的五个模块直接来自 deepseek-flow 仓库（零外部依赖），
// 因此 flow.json、WORKFLOW.md 结构块、布尔门语义与 dsh 版完全互通：
//   dsh 导出的 JSON → af create --json；af 的 flow.json → dsh flow_put。
//
// 存储布局（root 默认 ~/.agent-flow，可用 --root 或 AF_HOME 覆盖）：
//   <root>/flows/<id>/flow.json      机器可读定义（docRoot 不落盘，加载时指向本目录）
//   <root>/flows/<id>/WORKFLOW.md    总纲（含结构块与逻辑门执行契约）
//   <root>/flows/<id>/NN-slug/STEP.md 每步工作区
//   <root>/flows/<id>/state.json     执行簿记（af done/undo/next）
//   <root>/trash/<时间戳-id>/        删除归档，可手工恢复
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createScaffoldFlow,
  documentWorkflowInternals,
  normalizeDocumentFlow,
  orderedNodeIds,
  writeFlowDocuments
} from "../lib/document-workflow.js";
import { validateFlow } from "../lib/flow-validation.js";
import { evaluateFlowLogic, logicExecutionContract } from "../lib/logic-semantics.js";
import {
  flowDir,
  loadFlow,
  loadStateDir,
  readJsonIfPresent,
  readySteps,
  saveFlow,
  saveState,
  stepPath
} from "../lib/flow-service.mjs";

const { safeSegment } = documentWorkflowInternals;
const VERSION = "0.1.0";
const HELP = `af — AgentFlow：给任何编码代理用的 Markdown 工作流 CLI v${VERSION}

用法：af <命令> [参数]

  create <name> [--desc "目标"] [--steps "a;b;c"] [--json flow.json]  新建工作流
  list [--json]                    列出全部工作流与进度
  read <id> [--json]               输出总纲、每步 STEP.md 与逻辑契约
  validate <id>                    无环/结构/门语义校验（确定性，不调用模型）
  evaluate <id> --values '{"节点id":true}'  按真值表计算逻辑门并给出激活目标
  next <id> [--json]               下一步该执行什么（含可并行集合）
  done <id> <nodeId>               标记步骤完成并提示下一步
  undo <id> <nodeId>               取消完成标记
  status <id>                      进度总览（完成/待办/阻塞）
  render <id>                      重建 WORKFLOW.md 结构块（手工改文档后修复一致性）
  delete <id> [--yes]              归档删除（进 trash，可手工恢复）
  studio [--port N] [--app] [--pet]  启动本地可视化画布（默认 127.0.0.1:4317）

全局：--root <dir> 或环境变量 AF_HOME 指定存储根（默认 ~/.agent-flow）。

执行循环（技能会教代理）：af next → 读对应 STEP.md → 在当前会话完成工作 →
把产物/结论写回该步骤工作区 → af done → 循环直到 output 完成 → af validate 收尾。`;

// ---------- 参数与路径 ----------

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function flowRoot(options) {
  return resolve(options.root ?? process.env.AF_HOME ?? join(homedir(), ".agent-flow"));
}

function fail(message, code = 1) {
  process.stderr.write(`af: ${message}\n`);
  process.exit(code);
}

const ok = (message) => {
  process.stdout.write(`${message}\n`);
};

function describeStep(flow, entry, index = 0) {
  const { nodeId, node } = entry;
  return `${index + 1}. [${node.kind}] ${node.data?.label ?? nodeId}  →  ${stepPath(flow, nodeId)}  (${nodeId})`;
}

// ---------- 命令实现 ----------

async function commandCreate(positional, options) {
  const name = positional[0];
  if (!name && !options.json) fail("用法：af create <name> [--steps a;b;c] [--json flow.json]");
  const root = flowRoot(options);
  let flow;
  if (options.json) {
    const imported = JSON.parse(await readFile(resolve(options.json), "utf8"));
    if (!imported.id || !Array.isArray(imported.nodes) || !Array.isArray(imported.edges)) {
      fail("JSON 缺少 id/nodes/edges；请使用 DeepSeek Flow 导出的 flow.json");
    }
    // 导入时丢弃原机器的绝对 docRoot，docs 相对路径原样保留。
    const { docRoot: _docRoot, ...rest } = imported;
    flow = rest;
  } else {
    const steps = String(options.steps ?? "")
      .split(/[;；]/)
      .map((step) => step.trim())
      .filter(Boolean)
      .map((label) => ({ label }));
    flow = createScaffoldFlow({
      name,
      description: options.desc,
      ...(steps.length > 0 ? { steps } : {})
    });
  }
  const id = `${safeSegment(flow.name, "flow")}-${Date.now().toString(36).slice(-4)}`;
  const dir = flowDir(root, id);
  const normalized = normalizeDocumentFlow(
    { ...flow, id, docRoot: dir },
    { storageRoot: root, scope: "shared" }
  );
  const documented = await writeFlowDocuments(normalized);
  await saveFlow(dir, documented);
  await saveState(dir, { done: [] });
  const result = validateFlow(documented);
  ok(`已创建工作流 ${id}（${documented.nodes.length} 个节点，${documented.edges.length} 条箭头）`);
  ok(`目录：${dir}`);
  ok(`总纲：${join(dir, documented.workflowDoc ?? "WORKFLOW.md")}`);
  ok(`执行顺序：${result.order.join(" → ")}`);
  ok(`下一步：af next ${id}`);
}

async function commandList(options) {
  const root = flowRoot(options);
  let entries = [];
  try {
    entries = await readdir(join(root, "flows"), { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const flows = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const stored = await readJsonIfPresent(join(root, "flows", entry.name, "flow.json"));
    if (!stored) continue;
    const state = (await readJsonIfPresent(join(root, "flows", entry.name, "state.json"))) ?? { done: [] };
    const total = (stored.nodes ?? []).filter((node) => node.kind !== "input").length;
    flows.push({
      id: entry.name,
      name: stored.name ?? entry.name,
      nodes: (stored.nodes ?? []).length,
      edges: (stored.edges ?? []).length,
      done: (state.done ?? []).length,
      total,
      updatedAt: stored.updatedAt ?? null
    });
  }
  if (options.json) {
    ok(JSON.stringify(flows, null, 2));
    return;
  }
  if (flows.length === 0) {
    ok("还没有工作流。用 af create <name> --steps \"第一步;第二步;第三步\" 新建。");
    return;
  }
  for (const flow of flows) {
    ok(`${flow.id}  ${flow.name}  [${flow.done}/${flow.total} 步完成]  ${flow.nodes} 节点 / ${flow.edges} 箭头`);
  }
}

async function commandRead(positional, options) {
  const { flow } = await loadFlow(flowRoot(options), positional[0]);
  const nodeById = new Map(flow.nodes.map((node) => [node.id, node]));
  const payload = {
    id: flow.id,
    name: flow.name,
    description: flow.description ?? "",
    workflowDoc: flow.workflowDoc ?? "WORKFLOW.md",
    workflowContent: flow.workflowContent ?? "",
    logicContract: logicExecutionContract(flow),
    execution: "按 steps 顺序在当前会话执行每个 STEP.md；逻辑门用 af evaluate 求值，af 本身不执行任何步骤。",
    steps: orderedNodeIds(flow).map((nodeId, index) => {
      const node = nodeById.get(nodeId);
      return {
        order: index + 1,
        id: nodeId,
        kind: node.kind,
        label: node.data?.label ?? nodeId,
        path: stepPath(flow, nodeId),
        content: node.data?.prompt ?? node.data?.instructions ?? ""
      };
    })
  };
  if (options.json) ok(JSON.stringify(payload, null, 2));
  else {
    ok(`# ${flow.name}（${flow.id}）`);
    ok(payload.workflowContent);
    ok("\n## 步骤索引");
    for (const step of payload.steps) {
      ok(`${step.order}. [${step.kind}] ${step.label} → ${step.path}`);
    }
  }
}

async function commandValidate(positional, options) {
  const { flow } = await loadFlow(flowRoot(options), positional[0]);
  try {
    const result = validateFlow(flow);
    ok("✓ 结构合法：无环、连通、输入输出齐全，门语义一致。");
    ok(`执行顺序：${result.order.join(" → ")}`);
    result.levels.forEach((level, index) => ok(`  第 ${index + 1} 层：${level.join(", ")}`));
  } catch (error) {
    fail(`✗ 校验失败：\n${(error?.issues ?? [error?.message ?? String(error)]).map((issue) => `  - ${issue}`).join("\n")}`);
  }
}

async function commandEvaluate(positional, options) {
  const { flow } = await loadFlow(flowRoot(options), positional[0]);
  if (!options.values) fail("缺少 --values，例如 --values '{\"check-a\":true,\"check-b\":false}'");
  let values;
  try {
    values = JSON.parse(options.values);
  } catch (error) {
    fail(`--values 不是合法 JSON：${error.message}`);
  }
  try {
    const evaluation = evaluateFlowLogic(flow, values);
    ok(JSON.stringify(evaluation, null, 2));
  } catch (error) {
    fail(`逻辑求值失败：\n${(error?.issues ?? [error?.message ?? String(error)]).map((issue) => `  - ${issue}`).join("\n")}`);
  }
}

async function commandNext(positional, options) {
  const { flow, state } = await loadFlow(flowRoot(options), positional[0]);
  const { ready, blocked } = readySteps(flow, state);
  if (options.json) {
    ok(JSON.stringify({
      ready: ready.map((entry) => ({
        id: entry.nodeId,
        kind: entry.node.kind,
        label: entry.node.data?.label ?? entry.nodeId,
        path: stepPath(flow, entry.nodeId)
      })),
      blocked: [...blocked.entries()].map(([nodeId, waiting]) => ({ id: nodeId, waitingFor: waiting }))
    }, null, 2));
    return;
  }
  if (ready.length === 0) {
    const outputDone = flow.nodes
      .filter((node) => node.kind === "output")
      .every((node) => state.done?.includes(node.id));
    ok(outputDone ? "全部步骤已完成。建议跑一次 af validate 收尾。" : "没有可执行步骤；被阻塞的节点见 af status。");
    return;
  }
  ok("可立即执行（相互独立的步骤可并行）：");
  ready.forEach((entry, index) => ok(describeStep(flow, entry, index)));
  ok("完成后运行：af done <id> <nodeId>");
}

async function commandDone(positional, options) {
  const [id, nodeId] = positional;
  const { dir, flow } = await loadFlow(flowRoot(options), id);
  if (!nodeId) fail("用法：af done <id> <nodeId>");
  if (!flow.nodes.some((node) => node.id === nodeId)) fail(`节点 ${nodeId} 不存在于 ${id}`);
  const state = await loadStateDir(dir);
  if (!state.done.includes(nodeId)) state.done.push(nodeId);
  await saveState(dir, state);
  ok(`✓ 已完成 ${nodeId}（${flow.nodes.find((node) => node.id === nodeId)?.data?.label ?? nodeId}）`);
  const { ready } = readySteps(flow, state);
  if (ready.length > 0) {
    ok("下一步：");
    ready.forEach((entry, index) => ok(describeStep(flow, entry, index)));
  } else {
    ok("没有更多可执行步骤。跑 af status 检查剩余项，或 af validate 收尾。");
  }
}

async function commandUndo(positional, options) {
  const [id, nodeId] = positional;
  const { dir } = await loadFlow(flowRoot(options), id);
  if (!nodeId) fail("用法：af undo <id> <nodeId>");
  const state = await loadStateDir(dir);
  state.done = state.done.filter((candidate) => candidate !== nodeId);
  await saveState(dir, state);
  ok(`✓ 已撤销 ${nodeId} 的完成标记`);
}

async function commandStatus(positional, options) {
  const { flow, state } = await loadFlow(flowRoot(options), positional[0]);
  const { ready, blocked } = readySteps(flow, state);
  const nodeById = new Map(flow.nodes.map((node) => [node.id, node]));
  const total = flow.nodes.filter((node) => node.kind !== "input").length;
  ok(`进度：${state.done.length}/${total} 步完成`);
  ok(`已完成：${state.done.map((nodeId) => nodeById.get(nodeId)?.data?.label ?? nodeId).join("、") || "无"}`);
  if (ready.length > 0) {
    ok("待执行：");
    ready.forEach((entry, index) => ok(describeStep(flow, entry, index)));
  }
  if (blocked.size > 0) {
    ok("阻塞中：");
    for (const [nodeId, waiting] of blocked) {
      ok(`  ${nodeById.get(nodeId)?.data?.label ?? nodeId} ← 等待 ${waiting.map((source) => nodeById.get(source)?.data?.label ?? source).join("、")}`);
    }
  }
}

async function commandRender(positional, options) {
  const { dir, flow } = await loadFlow(flowRoot(options), positional[0]);
  const documented = await writeFlowDocuments({ ...flow, docRoot: dir });
  await saveFlow(dir, documented);
  ok(`✓ 已重建 ${join(dir, documented.workflowDoc ?? "WORKFLOW.md")} 的结构块与逻辑门契约`);
}

async function commandStudio(_positional, options) {
  const { startStudioServer, openInBrowser } = await import("../studio/server.mjs");
  const root = flowRoot(options);
  const requestedPort = Number(options.port);
  const handle = await startStudioServer({
    root,
    port: Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4317
  });
  const suffix = options.pet ? "?mode=pet" : "";
  const url = `http://127.0.0.1:${handle.port}/${suffix}`;
  ok(`AgentFlow Studio 已启动：${url}`);
  ok(`数据根：${root}；Ctrl/Cmd+C 退出。`);
  if (!options["no-open"]) openInBrowser(url, options.app === true);
  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {});
}

async function commandDelete(positional, options) {
  const [id] = positional;
  if (!id) fail("用法：af delete <id> [--yes]");
  const root = flowRoot(options);
  const dir = flowDir(root, id);
  const stored = await readJsonIfPresent(join(dir, "flow.json"));
  if (!stored) fail(`工作流 ${id} 不存在`, 2);
  if (options.yes !== true) {
    fail(`确认删除 ${id}？目录会移入 ${join(root, "trash")}，可手工恢复。加 --yes 执行。`, 2);
  }
  const trashDir = join(root, "trash", `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`);
  await mkdir(join(root, "trash"), { recursive: true });
  await rename(dir, trashDir);
  ok(`✓ 已归档删除：${trashDir}`);
}

// ---------- 入口 ----------

const COMMANDS = {
  create: commandCreate,
  list: commandList,
  read: commandRead,
  validate: commandValidate,
  evaluate: commandEvaluate,
  next: commandNext,
  done: commandDone,
  undo: commandUndo,
  status: commandStatus,
  render: commandRender,
  delete: commandDelete,
  studio: commandStudio
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    ok(HELP);
    return;
  }
  if (command === "--version" || command === "version") {
    ok(`af ${VERSION}`);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) fail(`未知命令 ${command}；运行 af help 查看用法`, 2);
  const { positional, options } = parseArgs(rest);
  await handler(positional, options);
}

main().catch((error) => fail(error?.stack ?? String(error)));
