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
  doneIdsOf,
  loadFlow,
  loadStateDir,
  readJsonIfPresent,
  readySteps,
  saveFlow,
  saveState,
  stepPath
} from "../lib/flow-service.mjs";
import {
  compileExecution,
  completeNode,
  executionProgress,
  flowRevision,
  isExecutableNode,
  markRunning,
  normalizeExecutionState,
  reconcileAfterFlowChange,
  setNodeResult,
  StaleWorkflowError,
  undoNode
} from "../lib/execution-runtime.mjs";

const { safeSegment } = documentWorkflowInternals;
const VERSION = "0.2.4";
const HELP = `af — AgentFlow：给任何编码代理用的 Markdown 工作流 CLI v${VERSION}

用法：af <命令> [参数]

  create <name> [--desc "目标"] [--steps "a;b;c"] [--json flow.json] [--lang zh|en]  新建工作流（--json 导入时可指定文档语言）
  list [--json]                    列出全部工作流与进度
  read <id> [--json]               输出总纲、每步 STEP.md 与逻辑契约
  validate <id>                    结构/连通/门语义校验（确定性，不调用模型）
  evaluate <id> --values '{"节点id":true}'  诊断式逻辑求值（不改 Runtime 状态）
  next <id> [--json]               编译最新 revision，只返回 Agent 可执行 READY 节点
  done <id> <nodeId> [--result JSON] [--revision N]  提交结果并完成步骤；自动解析 Gate
  result <id> <nodeId> <json>       写入节点结果（可用于 Input 或补充 Agent 结果）
  undo <id> <nodeId>               撤销该节点及其下游的完成/结果状态
  status <id>                      进度总览（完成/待办/阻塞）
  render <id>                      重建 WORKFLOW.md 结构块（手工改文档后修复一致性）
  delete <id> [--yes]              归档删除（进 trash，可手工恢复）
  studio [--port N] [--app] [--pet]  启动本地可视化画布（默认 127.0.0.1:4317）
  doctor [--json]                  检查 Node、CLI、Studio 与常见 Agent skill 安装状态

全局：--root <dir> 或环境变量 AF_HOME 指定存储根（默认 ~/.agent-flow）。

执行循环（技能会教代理）：af next → 读对应 STEP.md → 在当前会话完成工作 →
把结构化结果用 af done --result 提交 → Runtime 自动执行 Gate/Merge → 循环直到 output 完成 → af validate 收尾。`;

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
    flow = { ...rest, revision: flowRevision(rest) };
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
    { ...flow, id, revision: flowRevision(flow), docRoot: dir },
    { storageRoot: root, scope: "shared" }
  );
  // 先校验再落盘：导入含环/悬空边的 JSON 时不在磁盘留下打不开的坏工作流。
  const result = validateFlow(normalized);
  const documented = await writeFlowDocuments(normalized, { lang: options.lang === "en" ? "en" : "zh" });
  await saveFlow(dir, documented);
  await saveState(dir, compileExecution(documented, normalizeExecutionState(documented, {})).state);
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
    const total = (stored.nodes ?? []).filter(isExecutableNode).length;
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
    execution: "Agent 只执行 af next 返回的 READY 节点；Condition/Merge 由 Runtime 自动处理，af done --result 会立即重新编译激活路径。",
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
    ok("✓ 结构合法：连通、输入输出齐全，门语义一致；图中允许显式控制环，Runtime 对未收敛环保持等待。");
  const commandHint = result.order.length < flow.nodes.length
    ? "Runtime 对未收敛的控制环保持等待"
    : "Runtime 按依赖顺序执行";
  ok(`执行顺序：${result.order.join(" → ")}（${commandHint}）`);
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
  const { dir, flow, state } = await loadFlow(flowRoot(options), positional[0]);
  const compiled = readySteps(flow, state);
  compiled.state.running = markRunning(flow, compiled.state, compiled.ready).running;
  await saveState(dir, compiled.state);
  if (options.json) {
    ok(JSON.stringify({
      flowRevision: flowRevision(flow),
      ready: compiled.ready.map((entry) => ({
        id: entry.nodeId,
        kind: entry.node.kind,
        label: entry.node.data?.label ?? entry.nodeId,
        path: stepPath(flow, entry.nodeId),
        fingerprint: compiled.state.running?.fingerprints?.[entry.nodeId] ?? null
      })),
      blocked: [...compiled.blocked.entries()].map(([nodeId, waiting]) => ({ id: nodeId, waitingFor: waiting })),
      skipped: compiled.state.skipped,
      gates: compiled.state.gates,
      edgeStates: compiled.state.edgeStates
    }, null, 2));
    return;
  }
  ok(`Runtime rev ${flowRevision(flow)} · ${compiled.state.skipped.length} skipped · ${Object.values(compiled.state.gates).filter((gate) => gate.status === "resolved").length} gate(s) resolved`);
  if (compiled.ready.length === 0) {
    const progress = executionProgress(flow, compiled.state);
    ok(progress.total > 0 && progress.done >= progress.total
      ? "全部 Agent 执行步骤已完成。建议跑一次 af validate 收尾。"
      : "没有可执行 READY 节点；运行 af status 查看 Gate、结果或依赖阻塞。"
    );
    return;
  }
  ok("可立即执行（只包含 Agent 可执行节点）：");
  compiled.ready.forEach((entry, index) => ok(describeStep(flow, entry, index)));
  ok(`完成后运行：af done ${flow.id} <nodeId> --result '<json>' --revision ${flowRevision(flow)}`);
}

function parseResultOption(positional, options, index = 2) {
  const raw = options.result !== undefined ? options.result : positional[index];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    fail(`result 不是合法 JSON：${error.message}`);
  }
}

async function commandDone(positional, options) {
  const [id, nodeId] = positional;
  if (!nodeId) fail("用法：af done <id> <nodeId> [--result JSON] [--revision N]");
  const { dir, flow, state } = await loadFlow(flowRoot(options), id);
  const result = parseResultOption(positional, options);
  try {
    const compiled = completeNode(flow, state, nodeId, { result, expectedRevision: options.revision });
    await saveState(dir, compiled.state);
    ok(`✓ 已完成 ${nodeId}（rev ${flowRevision(flow)}）${result === undefined ? "" : "，结果已写入 Runtime"}`);
    const gateResolved = Object.entries(compiled.state.gates).filter(([, gate]) => gate.status === "resolved");
    if (gateResolved.length > 0) {
      ok(`Gate：${gateResolved.map(([gateId, gate]) => `${gateId}=${String(gate.value)}`).join("，")}`);
    }
    if (compiled.ready.length > 0) {
      ok("下一步：");
      compiled.ready.forEach((entry, index) => ok(describeStep(flow, entry, index)));
    } else {
      ok("当前没有更多 READY 节点。跑 af status 检查剩余项，或 af validate 收尾。");
    }
  } catch (error) {
    if (error instanceof StaleWorkflowError || error?.code === "STALE_WORKFLOW") fail(`STALE_WORKFLOW
${error.message}`, 3);
    fail(error?.message ?? String(error));
  }
}

async function commandResult(positional, options) {
  const [id, nodeId] = positional;
  if (!nodeId) fail("用法：af result <id> <nodeId> <json>");
  const result = parseResultOption(positional, options);
  if (result === undefined) fail("缺少结果 JSON");
  const { dir, flow, state } = await loadFlow(flowRoot(options), id);
  try {
    const compiled = setNodeResult(flow, state, nodeId, result);
    await saveState(dir, compiled.state);
    ok(`✓ 已写入 ${nodeId} 的结果；Runtime 已按 rev ${flowRevision(flow)} 重新编译。`);
  } catch (error) {
    fail(error?.message ?? String(error));
  }
}

async function commandUndo(positional, options) {
  const [id, nodeId] = positional;
  if (!nodeId) fail("用法：af undo <id> <nodeId>");
  const { dir, flow, state } = await loadFlow(flowRoot(options), id);
  try {
    const compiled = undoNode(flow, state, nodeId);
    await saveState(dir, compiled.state);
    ok(`✓ 已撤销 ${nodeId} 及其下游的完成/结果状态`);
  } catch (error) {
    fail(error?.message ?? String(error));
  }
}

async function commandStatus(positional, options) {
  const { dir, flow, state } = await loadFlow(flowRoot(options), positional[0]);
  const compiled = compileExecution(flow, state);
  await saveState(dir, compiled.state);
  const nodeById = new Map(flow.nodes.map((node) => [node.id, node]));
  const progress = executionProgress(flow, compiled.state);
  const doneIds = doneIdsOf(flow, compiled.state);
  ok(`Runtime：flow rev ${flowRevision(flow)} / state rev ${compiled.state.flowRevision} · ${progress.done}/${progress.total} 步完成`);
  ok(`已完成：${doneIds.map((nodeId) => nodeById.get(nodeId)?.data?.label ?? nodeId).join("、") || "无"}`);
  if (compiled.state.skipped.length > 0) {
    ok(`已跳过：${compiled.state.skipped.map((nodeId) => nodeById.get(nodeId)?.data?.label ?? nodeId).join("、")}`);
  }
  const gates = Object.entries(compiled.state.gates);
  if (gates.length > 0) {
    ok("Gate：");
    for (const [gateId, gate] of gates) {
      ok(`  ${nodeById.get(gateId)?.data?.label ?? gateId}: ${gate.status}${gate.status === "resolved" ? ` = ${String(gate.value)}` : ""}`);
    }
  }
  if (compiled.ready.length > 0) {
    ok("READY：");
    compiled.ready.forEach((entry, index) => ok(describeStep(flow, entry, index)));
  }
  if (compiled.blocked.size > 0) {
    ok("阻塞中：");
    for (const [nodeId, waiting] of compiled.blocked) {
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


async function commandDoctor(_positional, options) {
  const root = flowRoot(options);
  const home = homedir();
  const nodeMajor = Number(process.versions.node.split(".")[0] || 0);
  const skillCandidates = [
    { agent: "Claude Code", path: join(home, ".claude", "skills", "agent-flow", "SKILL.md") },
    { agent: "Codex", path: join(process.env.CODEX_HOME || join(home, ".codex"), "skills", "agent-flow", "SKILL.md") },
    { agent: "ZCode", path: join(home, ".zcode", "skills", "agent-flow", "SKILL.md") }
  ];

  const skillChecks = [];
  for (const item of skillCandidates) {
    let installed = false;
    try {
      await readFile(item.path, "utf8");
      installed = true;
    } catch {}
    skillChecks.push({ ...item, installed });
  }

  // Studio 资产随 CLI 安装（本文件旁边的 ../studio），不在数据根下。
  const studioAsset = new URL("../studio/index.html", import.meta.url);
  let studioInstalled = false;
  try {
    await readFile(studioAsset, "utf8");
    studioInstalled = true;
  } catch {}

  const checks = [
    { name: "Node >= 18", ok: nodeMajor >= 18, detail: process.versions.node },
    { name: "AgentFlow root", ok: true, detail: root },
    { name: "Studio assets", ok: studioInstalled, detail: studioAsset.pathname }
  ];
  const payload = { ok: checks.every((item) => item.ok), checks, skills: skillChecks };

  if (options.json) {
    ok(JSON.stringify(payload, null, 2));
    return;
  }

  ok("AgentFlow doctor");
  for (const check of checks) ok(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  ok("Skills:");
  for (const item of skillChecks) ok(`  ${item.installed ? "✓" : "·"} ${item.agent}: ${item.path}`);
  if (!skillChecks.some((item) => item.installed)) {
    ok("提示：未发现常见 Agent skill 安装；CLI 仍可使用。请回到 AgentFlow 仓库运行安装器，或按 INSTALL.md 安装技能。");
  }
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
  result: commandResult,
  undo: commandUndo,
  status: commandStatus,
  render: commandRender,
  delete: commandDelete,
  studio: commandStudio,
  doctor: commandDoctor
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
