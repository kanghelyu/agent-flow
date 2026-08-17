// af CLI 与 Studio 服务共享的流程数据层：读写 flow.json / state.json，
// 以及 Runtime 编译后的 done/ready/gate/edge 状态。flow.json 是唯一拓扑事实来源。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFlowDocuments, normalizeDocumentFlow } from "./document-workflow.js";
import {
  compileExecution,
  EXECUTION_STATE_VERSION,
  flowRevision,
  isExecutableNode,
  normalizeExecutionState
} from "./execution-runtime.mjs";

export async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function flowDir(root, id) {
  return join(root, "flows", id);
}

export async function loadFlow(root, id) {
  if (!id) throw new Error("缺少工作流 id");
  const dir = flowDir(root, id);
  const stored = await readJsonIfPresent(join(dir, "flow.json"));
  if (!stored) throw new Error(`工作流 ${id} 不存在（${dir}）`);
  // docRoot 不落盘：无论目录被移动/复制到哪台机器，加载时一律指向 flow.json 所在目录。
  const flow = await loadFlowDocuments(normalizeDocumentFlow(
    { revision: flowRevision(stored), ...stored, docRoot: dir },
    { storageRoot: root, scope: "shared" }
  ));
  const state = normalizeExecutionState(flow, await loadStateDir(dir));
  return { dir, root, flow, state };
}

export async function saveFlow(dir, flow) {
  const { docRoot: _docRoot, sessionId: _sessionId, ...portable } = flow;
  portable.revision = flowRevision(flow);
  await writeFile(join(dir, "flow.json"), `${JSON.stringify(portable, null, 2)}\n`, "utf8");
}

export async function loadStateDir(dir) {
  return (await readJsonIfPresent(join(dir, "state.json"))) ?? {
    schemaVersion: EXECUTION_STATE_VERSION,
    done: [],
    results: {},
    gates: {},
    edgeStates: {},
    skipped: [],
    running: null
  };
}

export async function saveState(dir, state) {
  await writeFile(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function doneIdsOf(flow, state) {
  const eligible = new Set((flow?.nodes ?? []).filter(isExecutableNode).map((node) => node.id));
  const raw = Array.isArray(state?.done) ? state.done : [];
  return [...new Set(raw)].filter((nodeId) => eligible.has(nodeId));
}

export function doneSetOf(flow, state) {
  // Input 与 Runtime 自动节点不写入 done；只有 Agent 真正执行的节点进入完成集合。
  return new Set(doneIdsOf(flow, state));
}

export function stepPath(flow, nodeId) {
  return flow.docs?.[nodeId] ?? `${nodeId}/STEP.md`;
}

export function readySteps(flow, state) {
  const compiled = compileExecution(flow, state);
  return {
    ready: compiled.ready,
    blocked: compiled.blocked,
    state: compiled.state,
    nodeStatus: compiled.nodeStatus,
    edgeValues: compiled.edgeValues
  };
}
