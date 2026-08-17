// AgentFlow Studio 本地服务 — 零依赖 HTTP + SSE。
// 只绑定 127.0.0.1：这是给本机浏览器/悬浮窗用的私有界面，不做对外服务。
// 所有拓扑变更（加删节点/箭头/门）都先在内存里跑 validateFlow，通过才落盘——
// 与 dsh 版「写入前拦截」同构，只是没有 AI 审查环节（agent-flow 的审查者就是 Agent 本身）。
import { createServer } from "node:http";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  conditionGateType,
  gateBranchForEdge,
  normalizeGateType
} from "../lib/condition-gates.js";
import { gateRule, logicExecutionContract, evaluateFlowLogic } from "../lib/logic-semantics.js";
import { validateFlow } from "../lib/flow-validation.js";
import { normalizeDocumentFlow, writeFlowDocuments } from "../lib/document-workflow.js";
import {
  flowDir,
  loadFlow,
  loadStateDir,
  readJsonIfPresent,
  readySteps,
  doneIdsOf,
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
  reconcileAfterFlowChange,
  undoNode
} from "../lib/execution-runtime.mjs";

const BODY_LIMIT = 2 * 1024 * 1024;
const KIND_LABELS = {
  input: "输入", agent: "Agent", mapAgent: "Map Agent", condition: "条件", merge: "合并", output: "输出"
};
const BRANCH_LABELS = { true: "是", false: "否", and: "与", or: "或", not: "非", nand: "与非", nor: "或非", xor: "异或", xnor: "同或" };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// id 只允许是 flows/ 下真实存在的目录名：先做字符白名单，再由 loadFlow 验证存在性。
function safeId(raw) {
  const id = decodeURIComponent(String(raw ?? ""));
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  return id;
}

function flowSummary(id, stored, state) {
  const compiled = compileExecution({ ...stored, revision: flowRevision(stored) }, state);
  const progress = executionProgress(stored, compiled.state);
  let valid = true;
  let issues = [];
  let cyclic = false;
  try {
    const result = validateFlow(stored);
    cyclic = result.cyclic === true;
  } catch (error) {
    valid = false;
    issues = error?.issues ?? [String(error?.message ?? error)];
  }
  return {
    id,
    name: stored.name ?? id,
    revision: flowRevision(stored),
    nodes: (stored.nodes ?? []).length,
    edges: (stored.edges ?? []).length,
    done: progress.done,
    total: progress.total,
    valid,
    cyclic,
    issues,
    synced: compiled.state.flowRevision === flowRevision(stored),
    updatedAt: stored.updatedAt ?? null
  };
}

async function listFlows(root) {
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
    const state = await loadStateDir(flowDir(root, entry.name));
    flows.push(flowSummary(entry.name, stored, state));
  }
  return flows;
}

function flowDetail({ flow, state }) {
  const compiled = readySteps(flow, state);
  const runtime = compiled.state;
  const doneIds = doneIdsOf(flow, runtime);
  const doneSet = new Set(doneIds);
  const readyIds = new Set(compiled.ready.map((entry) => entry.nodeId));
  const blockedMap = Object.fromEntries(compiled.blocked);
  const contract = logicExecutionContract(flow);
  const contractById = new Map(contract.conditions.map((condition) => [condition.nodeId, condition]));
  const progress = executionProgress(flow, runtime);
  let executable = true;
  let issues = [];
  let cyclic = false;
  try {
    const result = validateFlow(flow);
    cyclic = result.cyclic === true;
  } catch (error) { executable = false; issues = error?.issues ?? [String(error?.message ?? error)]; }
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description ?? "",
    revision: flowRevision(flow),
    workflowDoc: flow.workflowDoc ?? "WORKFLOW.md",
    workflowContent: flow.workflowContent ?? "",
    docRoot: flow.docRoot,
    progress,
    execution: {
      flowRevision: flowRevision(flow),
      stateRevision: runtime.flowRevision,
      synced: runtime.flowRevision === flowRevision(flow),
      executable,
      cyclic,
      issues,
      skipped: runtime.skipped,
      gates: runtime.gates,
      edgeStates: runtime.edgeStates
    },
    logicContract: contract,
    nodes: flow.nodes.map((node) => {
      const runtimeStatus = compiled.nodeStatus.get(node.id)?.status ?? (node.kind === "input" ? "resolved" : "idle");
      return {
        id: node.id,
        kind: node.kind,
        label: node.data?.label ?? node.id,
        content: node.data?.prompt ?? node.data?.instructions ?? "",
        position: node.position ?? { x: 120, y: 120 },
        path: stepPath(flow, node.id),
        done: doneSet.has(node.id),
        ready: readyIds.has(node.id),
        skipped: runtime.skipped.includes(node.id),
        runtimeStatus,
        blockedBy: blockedMap[node.id] ?? null,
        result: runtime.results?.[node.id],
        ...(node.kind === "condition"
          ? {
              gateType: conditionGateType(node, flow.edges.filter((edge) => edge.source === node.id)),
              formula: contractById.get(node.id)?.formula ?? "",
              predicate: node.data?.predicate ?? "truthy",
              valuePath: node.data?.valuePath ?? "",
              gateState: runtime.gates?.[node.id] ?? null
            }
          : {})
      };
    }),
    edges: flow.edges.map((edge) => {
      const branch = gateBranchForEdge(edge);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        branch,
        state: runtime.edgeStates?.[edge.id] ?? "pending",
        value: compiled.edgeValues?.[edge.id],
        label: edge.label ?? (branch ? BRANCH_LABELS[branch] ?? branch : null)
      };
    })
  };
}

/**
 * 画布编辑是渐进式的（先加节点、再连线，中间态天然「不可达」）：
 * 硬错误（环、门规则、重复、缺输入/输出）在每次变更时强制拦截；
 * 「不可达节点」作为软状态放行，由「校验」按钮和 af validate 严格把关。
 */
function validateTopologyEditable(flow) {
  try {
    const result = validateFlow(flow);
    return { ok: true, levels: result.levels };
  } catch (error) {
    const issues = error?.issues ?? [String(error?.message ?? error)];
    const incompleteGateIssues = new Set();
    for (const node of flow.nodes?.filter((candidate) => candidate?.kind === "condition") ?? []) {
      const outgoing = flow.edges?.filter((edge) => edge.source === node.id) ?? [];
      const gateType = conditionGateType(node, outgoing);
      const rule = gateRule(gateType);
      const inputCount = flow.edges?.filter((edge) => edge.target === node.id).length ?? 0;
      if (inputCount < rule.minInputs) {
        const expected = rule.maxInputs === rule.minInputs
          ? `requires exactly ${rule.minInputs} incoming Boolean input(s); received ${inputCount}`
          : `requires at least ${rule.minInputs} incoming Boolean inputs; received ${inputCount}`;
        incompleteGateIssues.add(`condition ${node.id} (${gateType}) ${expected}`);
      }
    }
    const hard = issues.filter((issue) =>
      !/^unreachable nodes:/.test(issue) && !incompleteGateIssues.has(issue)
    );
    if (hard.length > 0) return { ok: false, issues: hard };
    return { ok: true, levels: [] };
  }
}

/** 应用一次拓扑变更：改内存副本 → 校验 → 通过才写盘。失败原样返回 issues。 */
async function mutateTopology(root, id, mutator, { bumpRevision = true } = {}) {
  const { dir, flow, state } = await loadFlow(root, id);
  const draft = structuredClone(flow);
  const patch = mutator(draft) ?? {};
  const verdict = validateTopologyEditable(draft);
  if (!verdict.ok) return { ok: false, issues: verdict.issues };
  if (bumpRevision) draft.revision = flowRevision(flow) + 1;
  else draft.revision = flowRevision(flow);
  const levels = verdict.levels;
  const normalized = normalizeDocumentFlow(draft, {
    storageRoot: root, scope: "shared", docRoot: dir, previousFlow: flow
  });
  const documented = await writeFlowDocuments(normalized);
  documented.updatedAt = new Date().toISOString();
  await saveFlow(dir, documented);
  const reconciled = reconcileAfterFlowChange(flow, documented, state);
  await saveState(dir, reconciled.state);
  const loaded = await loadFlow(root, id);
  const detail = flowDetail({ flow: loaded.flow, state: reconciled.state });
  void patch;
  return { ok: true, detail, levels, revision: flowRevision(documented) };
}

function layoutPositions(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source).push(edge.target);
  }
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const level = new Map(queue.map((id) => [id, 0]));
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, (level.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  nodes.forEach((node, index) => {
    if (!level.has(node.id)) level.set(node.id, (order.length ? order.length : 0) + index);
  });
  const rows = new Map();
  return new Map(nodes.map((node) => {
    const column = level.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return [node.id, { x: 70 + column * 245, y: 90 + row * 160 }];
  }));
}

async function watchSignature(root) {
  let entries = [];
  try {
    entries = await readdir(join(root, "flows"), { withFileTypes: true });
  } catch {
    return "";
  }
  const parts = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const base = join(root, "flows", entry.name);
    const marks = [];
    for (const file of ["flow.json", "state.json"]) {
      try {
        marks.push((await stat(join(base, file))).mtimeMs);
      } catch {
        marks.push(0);
      }
    }
    parts.push(`${entry.name}:${marks.join(",")}`);
  }
  return parts.join("|");
}

export async function startStudioServer({ root, host = "127.0.0.1", port = 0 } = {}) {
  root = resolve(root ?? process.env.AF_HOME ?? join(homedir(), ".agent-flow"));
  const indexHtml = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const clients = new Set();
  let lastSignature = await watchSignature(root);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(indexHtml);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/flows") {
        sendJson(res, 200, await listFlows(root));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/flows") {
        const body = await readBody(req);
        const name = String(body.name || "").trim() || "工作流";
        const steps = Array.isArray(body.steps) && body.steps.length
          ? body.steps.map((s) => String(s).trim()).filter(Boolean)
          : ["第一步", "第二步", "第三步"];
        const id = `${name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "").slice(0, 24) || "flow"}-${Date.now().toString(36).slice(-4)}`;
        const dir = flowDir(root, id);
        const { createScaffoldFlow, normalizeDocumentFlow, writeFlowDocuments } = await import("../lib/document-workflow.js");
        const flow = createScaffoldFlow({ name, steps: steps.map((label) => ({ label })) });
        const normalized = normalizeDocumentFlow({ ...flow, id, docRoot: dir }, { storageRoot: root, scope: "shared" });
        const documented = await writeFlowDocuments(normalized);
        const { validateFlow } = await import("../lib/flow-validation.js");
        validateFlow(documented);
        documented.updatedAt = new Date().toISOString();
        await saveFlow(dir, documented);
        await saveState(dir, { done: [] });
        sendJson(res, 201, { id: documented.id, name: documented.name });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive"
        });
        res.write("event: hello\ndata: {}\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (parts[0] !== "api" || parts[1] !== "flow" || !parts[2]) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const id = safeId(parts[2]);
      if (!id) {
        sendJson(res, 400, { error: "bad flow id" });
        return;
      }
      const action = parts[3] ?? "";

      if (req.method === "GET" && action === "") {
        const loaded = await loadFlow(root, id);
        sendJson(res, 200, flowDetail(loaded));
        return;
      }
      if (req.method === "GET" && action === "validate") {
        const { flow } = await loadFlow(root, id);
      try {
          const result = validateFlow(flow);
          sendJson(res, 200, { ok: true, cyclic: result.cyclic === true, order: result.order, levels: result.levels });
        } catch (error) {
          sendJson(res, 200, { ok: false, issues: error?.issues ?? [String(error?.message ?? error)] });
        }
        return;
      }
      if (req.method === "GET" && action === "evaluate") {
        const { flow } = await loadFlow(root, id);
        let values = {};
        try {
          values = JSON.parse(url.searchParams.get("values") ?? "{}");
        } catch {
          sendJson(res, 400, { error: "values 不是合法 JSON" });
          return;
        }
        try {
          sendJson(res, 200, evaluateFlowLogic(flow, values));
        } catch (error) {
          sendJson(res, 200, { ok: false, issues: error?.issues ?? [String(error?.message ?? error)] });
        }
        return;
      }

      const body = await readBody(req);

      if (req.method === "POST" && (action === "done" || action === "undo")) {
        const { dir, flow, state } = await loadFlow(root, id);
        const nodeId = String(body.nodeId ?? "");
        const node = flow.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) {
          sendJson(res, 400, { error: `节点 ${nodeId} 不存在` });
          return;
        }
        try {
          const compiled = action === "done"
            ? completeNode(flow, state, nodeId, { result: body.result, expectedRevision: body.revision })
            : undoNode(flow, state, nodeId);
          await saveState(dir, compiled.state);
          sendJson(res, 200, flowDetail({ flow, state: compiled.state }));
        } catch (error) {
          const stale = error?.code === "STALE_WORKFLOW";
          sendJson(res, stale ? 409 : 400, { code: error?.code, error: String(error?.message ?? error) });
        }
        return;
      }

      if (req.method === "POST" && action === "doc") {
        const { dir, flow, state } = await loadFlow(root, id);
        const nodeId = String(body.nodeId ?? "");
        const node = flow.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) {
          sendJson(res, 400, { error: `节点 ${nodeId} 不存在` });
          return;
        }
        const key = node.kind === "agent" || node.kind === "mapAgent" ? "prompt" : "instructions";
        const nextContent = String(body.content ?? "");
        const previousContent = String(node.data?.[key] ?? "");
        node.data = { ...node.data, [key]: nextContent };
        if (nextContent !== previousContent) flow.revision = flowRevision(flow) + 1;
        const documented = await writeFlowDocuments(flow);
        documented.updatedAt = new Date().toISOString();
        await saveFlow(dir, documented);
        const reconciled = nextContent !== previousContent
          ? reconcileAfterFlowChange({ ...flow, revision: flowRevision(flow) - 1, nodes: flow.nodes.map((candidate) => candidate.id === nodeId ? { ...candidate, data: { ...candidate.data, [key]: previousContent } } : candidate) }, documented, state)
          : compileExecution(documented, state);
        await saveState(dir, reconciled.state);
        sendJson(res, 200, flowDetail({ flow: documented, state: reconciled.state }));
        return;
      }

      if (req.method === "POST" && action === "position") {
        const { dir, flow } = await loadFlow(root, id);
        const node = flow.nodes.find((candidate) => candidate.id === String(body.nodeId ?? ""));
        if (!node) {
          sendJson(res, 400, { error: "节点不存在" });
          return;
        }
        const x = Number(body.x);
        const y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          sendJson(res, 400, { error: "节点坐标必须是有限数字" });
          return;
        }
        node.position = {
          x: Math.max(0, Math.round(x)),
          y: Math.max(0, Math.round(y))
        };
        const documented = await writeFlowDocuments(flow);
        await saveFlow(dir, documented);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && action === "layout") {
        // 整理只重排坐标，不改拓扑；含环/未完成的图也应能整理，
        // 因此绕开拓扑校验直接落盘（与 position 端点同策略）。
        const { dir, flow } = await loadFlow(root, id);
        const draft = structuredClone(flow);
        const positions = layoutPositions(draft.nodes, draft.edges);
        for (const node of draft.nodes) node.position = positions.get(node.id) ?? node.position;
        await saveFlow(dir, draft);
        const loaded = await loadFlow(root, id);
        sendJson(res, 200, { ok: true, detail: flowDetail(loaded), levels: [] });
        return;
      }

      if (req.method === "POST" && action === "flow-delete") {
        const dir = flowDir(root, id);
        const stored = await readJsonIfPresent(join(dir, "flow.json"));
        if (!stored) {
          sendJson(res, 404, { error: `工作流 ${id} 不存在` });
          return;
        }
        const trashDir = join(root, "trash", `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`);
        await mkdir(join(root, "trash"), { recursive: true });
        await rename(dir, trashDir);
        sendJson(res, 200, { ok: true, archivedTo: trashDir });
        return;
      }

      if (req.method === "POST" && action === "node-add") {
        const kind = KIND_LABELS[body.kind] ? body.kind : "agent";
        const suffix = Math.random().toString(36).slice(2, 7);
        const requestedX = Number(body.x);
        const requestedY = Number(body.y);
        const x = Number.isFinite(requestedX) ? requestedX : 160;
        const y = Number.isFinite(requestedY) ? requestedY : 120;
        const result = await mutateTopology(root, id, (draft) => {
          draft.nodes.push({
            id: `${kind}-${suffix}`,
            kind,
            position: {
              x: Math.max(0, Math.round(x)),
              y: Math.max(0, Math.round(y))
            },
            data: {
              label: KIND_LABELS[kind],
              ...(kind === "condition" ? { gateType: normalizeGateType(body.gateType) } : {}),
              ...(kind === "agent" || kind === "mapAgent" ? { prompt: "{{input}}" } : {})
            }
          });
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "POST" && action === "node-delete") {
        const nodeId = String(body.nodeId ?? "");
        const result = await mutateTopology(root, id, (draft) => {
          draft.nodes = draft.nodes.filter((node) => node.id !== nodeId);
          draft.edges = draft.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "POST" && action === "node-patch") {
        const nodeId = String(body.nodeId ?? "");
        const patch = body.patch ?? {};
        const result = await mutateTopology(root, id, (draft) => {
          const node = draft.nodes.find((candidate) => candidate.id === nodeId);
          if (!node) throw new Error(`节点 ${nodeId} 不存在`);
          if (patch.gateType !== undefined && draft.edges.some((edge) => edge.source === nodeId)) {
            throw new Error("该条件框已有出线：请先删除这些箭头，再修改逻辑门类型");
          }
          node.data = { ...node.data, ...patch };
        });
        sendJson(res, result.ok ? 200 : 400, result.ok ? result : { ok: false, issues: result.issues });
        return;
      }

      if (req.method === "POST" && action === "edge-add") {
        const sourceId = String(body.source ?? "");
        const targetId = String(body.target ?? "");
        const { flow } = await loadFlow(root, id);
        const source = flow.nodes.find((node) => node.id === sourceId);
        if (!source) {
          sendJson(res, 400, { ok: false, error: "起点不存在" });
          return;
        }
        if (source.kind === "condition") {
          const outgoing = flow.edges.filter((edge) => edge.source === sourceId);
          const gateType = conditionGateType(source, outgoing);
          const branch = body.branch !== undefined && body.branch !== null ? String(body.branch) : null;
          const used = new Set(outgoing.map((edge) => gateBranchForEdge(edge)).filter(Boolean));
          let chosen = branch;
          if (gateType === "ifElse" && !chosen) {
            const free = ["true", "false"].filter((candidate) => !used.has(candidate));
            if (free.length === 0) {
              sendJson(res, 400, { ok: false, error: "这个是/否条件两条分支都已使用" });
              return;
            }
            if (free.length > 1) {
              sendJson(res, 200, { ok: false, code: "choose-branch", available: free });
              return;
            }
            chosen = free[0];
          } else if (gateType !== "ifElse" && !chosen) {
            chosen = gateType;
          }
          if (gateType === "not" && outgoing.length > 0) {
            sendJson(res, 400, { ok: false, error: "非门只允许一条出线" });
            return;
          }
          const result = await mutateTopology(root, id, (draft) => {
            draft.edges.push({
              id: `e-${sourceId}-${targetId}-${Math.random().toString(36).slice(2, 6)}`,
              source: sourceId,
              target: targetId,
              ...(chosen ? { sourceHandle: chosen } : {})
            });
          });
          sendJson(res, result.ok ? 200 : 400, result);
          return;
        }
        const result = await mutateTopology(root, id, (draft) => {
          draft.edges.push({
            id: `e-${sourceId}-${targetId}-${Math.random().toString(36).slice(2, 6)}`,
            source: sourceId,
            target: targetId
          });
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "POST" && action === "edge-delete") {
        const result = await mutateTopology(root, id, (draft) => {
          draft.edges = draft.edges.filter((edge) => edge.id !== String(body.edgeId ?? ""));
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, error?.message?.includes("不存在") ? 404 : 400, { error: String(error?.message ?? error) });
    }
  });

  // 先绑定端口，再启动 watcher。listen 的 EADDRINUSE 是 EventEmitter error，
  // 不能只靠 listen callback 的 Promise，否则 Electron 主进程会收到 uncaught exception。
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  // 轮询式变更广播（跨平台，无 fs.watch 递归兼容问题）：1.2s 比对 flow.json/state.json 的 mtime 签名。
  const watcher = setInterval(async () => {
    try {
      const signature = await watchSignature(root);
      if (signature === lastSignature) return;
      lastSignature = signature;
      const frame = `event: change\ndata: {}\n\n`;
      for (const res of clients) res.write(frame);
    } catch {
      // 观察失败静默重试
    }
  }, 1200);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 15_000);

  return {
    server,
    root,
    host,
    port: server.address().port,
    async stop() {
      clearInterval(watcher);
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

export function openInBrowser(url, appMode = false) {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32"
    ? ["/c", "start", "", url]
    : process.platform === "darwin" && appMode
      ? ["-na", "Google Chrome", "--args", "--app", url]
      : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

export const studioInternals = { flowSummary, layoutPositions, safeId };
