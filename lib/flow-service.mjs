// af CLI 与 studio 服务共享的流程数据层：读写 flow.json / state.json，
// 以及执行簿记（doneSet / readySteps）。单一事实来源，避免两端口径漂移。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFlowDocuments, normalizeDocumentFlow, orderedNodeIds } from "./document-workflow.js";

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
    { ...stored, docRoot: dir },
    { storageRoot: root, scope: "shared" }
  ));
  const state = await loadStateDir(dir);
  return { dir, root, flow, state };
}

export async function saveFlow(dir, flow) {
  const { docRoot: _docRoot, sessionId: _sessionId, ...portable } = flow;
  await writeFile(join(dir, "flow.json"), `${JSON.stringify(portable, null, 2)}\n`, "utf8");
}

export async function loadStateDir(dir) {
  return (await readJsonIfPresent(join(dir, "state.json"))) ?? { done: [] };
}

export async function saveState(dir, state) {
  await writeFile(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function doneSetOf(flow, state) {
  // Input 是流程起点，视为恒已完成；其余以 state.done 为准。
  return new Set([...state.done, ...flow.nodes.filter((node) => node.kind === "input").map((node) => node.id)]);
}

export function stepPath(flow, nodeId) {
  return flow.docs?.[nodeId] ?? `${nodeId}/STEP.md`;
}

export function readySteps(flow, state) {
  const doneSet = doneSetOf(flow, state);
  const nodeById = new Map(flow.nodes.map((node) => [node.id, node]));
  const blocked = new Map();
  const ready = [];
  for (const nodeId of orderedNodeIds(flow)) {
    const node = nodeById.get(nodeId);
    if (!node || node.kind === "input" || doneSet.has(nodeId)) continue;
    const waiting = flow.edges
      .filter((edge) => edge.target === nodeId && !doneSet.has(edge.source))
      .map((edge) => edge.source);
    if (waiting.length === 0) ready.push({ nodeId, node });
    else blocked.set(nodeId, waiting);
  }
  return { ready, blocked };
}
