import { createHash } from "node:crypto";
import { conditionGateType, gateBranchForEdge } from "./condition-gates.js";
import { orderedNodeIds } from "./document-workflow.js";
import { evaluateGate, evaluatePredicate, gateRule, normalizePredicate } from "./logic-semantics.js";

export const EXECUTABLE_NODE_KINDS = Object.freeze(["agent", "mapAgent", "output"]);
const EXECUTABLE_KIND_SET = new Set(EXECUTABLE_NODE_KINDS);
const AUTOMATIC_KIND_SET = new Set(["condition", "merge"]);
export const EXECUTION_STATE_VERSION = 2;

export class StaleWorkflowError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StaleWorkflowError";
    this.code = "STALE_WORKFLOW";
    this.details = details;
  }
}

export function isExecutableNode(node) {
  return EXECUTABLE_KIND_SET.has(node?.kind);
}

export function isAutomaticNode(node) {
  return AUTOMATIC_KIND_SET.has(node?.kind);
}

export function flowRevision(flow) {
  const value = Number(flow?.revision);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function cleanNodeData(node) {
  const data = { ...(node?.data ?? {}) };
  delete data.workspace;
  delete data.order;
  return data;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(stableObject(value))).digest("hex").slice(0, 24);
}

function ancestorIds(flow, nodeId) {
  const seen = new Set([nodeId]);
  const pending = [nodeId];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const edge of flow?.edges ?? []) {
      if (edge.target !== current || seen.has(edge.source)) continue;
      seen.add(edge.source);
      pending.push(edge.source);
    }
  }
  return seen;
}

export function executionFingerprint(flow, nodeId) {
  const ids = ancestorIds(flow, nodeId);
  const nodes = (flow?.nodes ?? [])
    .filter((node) => ids.has(node.id))
    .map((node) => ({ id: node.id, kind: node.kind, data: cleanNodeData(node) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = (flow?.edges ?? [])
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      branch: gateBranchForEdge(edge) ?? null
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return hash({ nodeId, nodes, edges });
}

function freshState(flow) {
  return {
    schemaVersion: EXECUTION_STATE_VERSION,
    flowRevision: flowRevision(flow),
    done: [],
    results: {},
    gates: {},
    edgeStates: {},
    skipped: [],
    running: null
  };
}

export function normalizeExecutionState(flow, rawState = {}) {
  const base = freshState(flow);
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const validNodeIds = new Set(nodeById.keys());
  const validEdgeIds = new Set((flow?.edges ?? []).map((edge) => edge.id));
  const done = Array.isArray(rawState?.done)
    ? [...new Set(rawState.done)].filter((id) => isExecutableNode(nodeById.get(id)))
    : [];
  const results = {};
  for (const [nodeId, value] of Object.entries(rawState?.results ?? {})) {
    if (validNodeIds.has(nodeId)) results[nodeId] = value;
  }
  const gates = {};
  for (const [nodeId, value] of Object.entries(rawState?.gates ?? {})) {
    if (nodeById.get(nodeId)?.kind === "condition") gates[nodeId] = value;
  }
  const edgeStates = {};
  for (const [edgeId, value] of Object.entries(rawState?.edgeStates ?? {})) {
    if (validEdgeIds.has(edgeId) && ["active", "inactive", "pending"].includes(value)) edgeStates[edgeId] = value;
  }
  const skipped = Array.isArray(rawState?.skipped)
    ? [...new Set(rawState.skipped)].filter((id) => validNodeIds.has(id) && nodeById.get(id)?.kind !== "input")
    : [];
  return {
    ...base,
    ...rawState,
    schemaVersion: EXECUTION_STATE_VERSION,
    flowRevision: flowRevision(flow),
    done,
    results,
    gates,
    edgeStates,
    skipped,
    running: rawState?.running && typeof rawState.running === "object" ? rawState.running : null
  };
}

function descendantsOf(flow, nodeIds) {
  const seen = new Set(nodeIds);
  const pending = [...nodeIds];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const edge of flow?.edges ?? []) {
      if (edge.source !== current || seen.has(edge.target)) continue;
      seen.add(edge.target);
      pending.push(edge.target);
    }
  }
  return seen;
}

export function invalidateNodes(flow, rawState, nodeIds, { includeRoots = true } = {}) {
  const state = normalizeExecutionState(flow, rawState);
  const roots = new Set(nodeIds);
  const affected = descendantsOf(flow, roots);
  if (!includeRoots) for (const id of roots) affected.delete(id);
  state.done = state.done.filter((id) => !affected.has(id));
  for (const id of affected) {
    delete state.results[id];
    delete state.gates[id];
  }
  state.skipped = state.skipped.filter((id) => !affected.has(id));
  return state;
}

function parsePath(path) {
  const text = String(path ?? "").trim();
  if (!text || text === "$") return [];
  if (!text.startsWith("$.")) throw new Error(`valuePath must start with $. (received ${text})`);
  const body = text.slice(2).replace(/\[(\d+)\]/g, ".$1");
  if (!body) return [];
  return body.split(".").filter(Boolean);
}

export function readValuePath(value, path) {
  const parts = parsePath(path);
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function valueForConditionInput(node, sourceId, rawValue) {
  const perInput = node?.data?.inputValuePaths;
  const explicitPath = perInput?.[sourceId] ?? node?.data?.valuePath;
  if (explicitPath) return readValuePath(rawValue, explicitPath);
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) && Object.hasOwn(rawValue, "value")) {
    return rawValue.value;
  }
  return rawValue;
}

function predicateForConditionInput(node, sourceId) {
  return normalizePredicate(node?.data?.inputPredicates?.[sourceId] ?? node?.data?.predicate ?? "truthy");
}

function sourceSatisfied(nodeById, nodeStatus, doneSet, sourceId) {
  const source = nodeById.get(sourceId);
  if (!source) return false;
  if (source.kind === "input") return true;
  if (source.kind === "condition" || source.kind === "merge") return nodeStatus.get(sourceId)?.status === "resolved";
  return doneSet.has(sourceId);
}

function waitingSources(incoming, edgeStates, nodeById, nodeStatus, doneSet) {
  const waiting = [];
  for (const edge of incoming) {
    const state = edgeStates[edge.id];
    if (state === "pending") {
      waiting.push(edge.source);
      continue;
    }
    if (state !== "active") continue;
    if (!sourceSatisfied(nodeById, nodeStatus, doneSet, edge.source)) waiting.push(edge.source);
  }
  return [...new Set(waiting)];
}

function topologicalOrder(flow) {
  return orderedNodeIds(flow);
}

export function compileExecution(flow, rawState = {}) {
  const state = normalizeExecutionState(flow, rawState);
  const nodes = flow?.nodes ?? [];
  const edges = flow?.edges ?? [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge);
    incoming.get(edge.target)?.push(edge);
  }
  const doneSet = new Set(state.done);
  const edgeStates = {};
  const edgeValues = {};
  const nodeStatus = new Map();
  const gates = {};
  const skipped = new Set();
  const blocked = new Map();
  const ready = [];

  const publishOutgoing = (node) => {
    const status = nodeStatus.get(node.id);
    for (const edge of outgoing.get(node.id) ?? []) {
      if (node.kind === "condition") {
        if (status?.status === "pending" || status?.status === "blocked") {
          edgeStates[edge.id] = "pending";
          continue;
        }
        if (status?.status !== "resolved") {
          edgeStates[edge.id] = "inactive";
          continue;
        }
        const gateType = status.gateType;
        if (gateType === "ifElse") {
          const selected = gateBranchForEdge(edge) === (status.value ? "true" : "false");
          edgeStates[edge.id] = selected ? "active" : "inactive";
          if (selected) edgeValues[edge.id] = true;
          continue;
        }
        const target = nodeById.get(edge.target);
        const carriesFalseSignal = target?.kind === "condition";
        const active = Boolean(status.value) || carriesFalseSignal;
        edgeStates[edge.id] = active ? "active" : "inactive";
        edgeValues[edge.id] = Boolean(status.value);
        continue;
      }
      if (status?.status === "pending" || status?.status === "blocked" || status?.status === "ready" || status?.status === "done" || status?.status === "resolved") {
        edgeStates[edge.id] = "active";
      } else {
        edgeStates[edge.id] = "inactive";
      }
    }
  };

  for (const nodeId of topologicalOrder(flow)) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    if (node.kind === "input") {
      nodeStatus.set(nodeId, { status: "resolved", automatic: true });
      publishOutgoing(node);
      continue;
    }

    const ins = incoming.get(nodeId) ?? [];
    if (ins.length === 0) {
      nodeStatus.set(nodeId, { status: "unreachable" });
      skipped.add(nodeId);
      if (node.kind === "condition") gates[nodeId] = { status: "skipped", flowRevision: flowRevision(flow) };
      publishOutgoing(node);
      continue;
    }
    const pendingEdges = ins.filter((edge) => edgeStates[edge.id] === "pending");
    const activeEdges = ins.filter((edge) => edgeStates[edge.id] === "active");
    const inactiveEdges = ins.filter((edge) => edgeStates[edge.id] === "inactive");

    if (pendingEdges.length > 0) {
      const waiting = waitingSources(ins, edgeStates, nodeById, nodeStatus, doneSet);
      nodeStatus.set(nodeId, { status: "pending", waiting });
      if (waiting.length > 0 && isExecutableNode(node)) blocked.set(nodeId, waiting);
      if (node.kind === "condition") gates[nodeId] = { status: "pending", flowRevision: flowRevision(flow), waitingFor: waiting };
      publishOutgoing(node);
      continue;
    }
    if (activeEdges.length === 0) {
      nodeStatus.set(nodeId, { status: "skipped" });
      skipped.add(nodeId);
      if (node.kind === "condition") gates[nodeId] = { status: "skipped", flowRevision: flowRevision(flow) };
      publishOutgoing(node);
      continue;
    }

    if (node.kind === "condition") {
      // A gate is a data-flow operator: every declared operand must reach it. If an upstream branch is inactive,
      // the gate itself is not on the active control-flow path and is skipped instead of silently changing arity.
      if (inactiveEdges.length > 0) {
        nodeStatus.set(nodeId, { status: "skipped" });
        skipped.add(nodeId);
        gates[nodeId] = { status: "skipped", flowRevision: flowRevision(flow) };
        publishOutgoing(node);
        continue;
      }
      const outgoingEdges = outgoing.get(nodeId) ?? [];
      const gateType = conditionGateType(node, outgoingEdges);
      const rule = gateRule(gateType);
      if (ins.length < rule.minInputs || ins.length > rule.maxInputs) {
        const gate = { status: "pending", gateType, flowRevision: flowRevision(flow), reason: "invalid-arity" };
        gates[nodeId] = gate;
        nodeStatus.set(nodeId, gate);
        publishOutgoing(node);
        continue;
      }
      const waiting = waitingSources(ins, edgeStates, nodeById, nodeStatus, doneSet);
      const operands = [];
      for (const edge of activeEdges) {
        const source = nodeById.get(edge.source);
        if (!sourceSatisfied(nodeById, nodeStatus, doneSet, edge.source)) continue;
        let rawValue;
        if (source?.kind === "condition") rawValue = edgeValues[edge.id];
        else if (source?.kind === "merge") rawValue = true;
        else rawValue = state.results[edge.source];
        if (rawValue === undefined) {
          waiting.push(edge.source);
          continue;
        }
        const extracted = valueForConditionInput(node, edge.source, rawValue);
        const predicate = predicateForConditionInput(node, edge.source);
        operands.push({
          edgeId: edge.id,
          source: edge.source,
          predicate,
          valuePath: node?.data?.inputValuePaths?.[edge.source] ?? node?.data?.valuePath ?? null,
          value: evaluatePredicate(extracted, predicate)
        });
      }
      const uniqueWaiting = [...new Set(waiting)];
      if (uniqueWaiting.length > 0 || operands.length !== activeEdges.length) {
        const gate = { status: "pending", gateType, operands, flowRevision: flowRevision(flow), waitingFor: uniqueWaiting };
        gates[nodeId] = gate;
        nodeStatus.set(nodeId, gate);
        publishOutgoing(node);
        continue;
      }
      const value = evaluateGate(gateType, operands.map((operand) => operand.value));
      const gate = { status: "resolved", gateType, value, operands, flowRevision: flowRevision(flow) };
      gates[nodeId] = gate;
      nodeStatus.set(nodeId, gate);
      publishOutgoing(node);
      continue;
    }

    if (node.kind === "merge") {
      const waiting = waitingSources(activeEdges, edgeStates, nodeById, nodeStatus, doneSet);
      if (waiting.length > 0) {
        nodeStatus.set(nodeId, { status: "blocked", automatic: true, waiting });
      } else {
        nodeStatus.set(nodeId, { status: "resolved", automatic: true });
      }
      publishOutgoing(node);
      continue;
    }

    if (isExecutableNode(node)) {
      if (doneSet.has(nodeId)) {
        nodeStatus.set(nodeId, { status: "done" });
      } else {
        const waiting = waitingSources(activeEdges, edgeStates, nodeById, nodeStatus, doneSet);
        if (waiting.length === 0) {
          nodeStatus.set(nodeId, { status: "ready" });
          ready.push({ nodeId, node });
        } else {
          nodeStatus.set(nodeId, { status: "blocked", waiting });
          blocked.set(nodeId, waiting);
        }
      }
      publishOutgoing(node);
      continue;
    }

    nodeStatus.set(nodeId, { status: "skipped" });
    skipped.add(nodeId);
    publishOutgoing(node);
  }

  state.gates = gates;
  state.edgeStates = Object.fromEntries(edges.map((edge) => [edge.id, edgeStates[edge.id] ?? "pending"]));
  state.skipped = [...skipped];
  state.flowRevision = flowRevision(flow);
  return { state, ready, blocked, nodeStatus, edgeValues };
}

export function markRunning(flow, rawState, readyEntries) {
  const compiled = compileExecution(flow, rawState);
  const entries = Array.isArray(readyEntries) ? readyEntries : compiled.ready;
  if (entries.length === 0) {
    compiled.state.running = null;
    return compiled.state;
  }
  const fingerprints = Object.fromEntries(entries.map((entry) => [entry.nodeId, executionFingerprint(flow, entry.nodeId)]));
  compiled.state.running = {
    ...(entries.length === 1 ? { nodeId: entries[0].nodeId } : { nodeIds: entries.map((entry) => entry.nodeId) }),
    flowRevision: flowRevision(flow),
    startedAt: new Date().toISOString(),
    fingerprints
  };
  return compiled.state;
}

function assertFreshCompletion(flow, state, nodeId, expectedRevision) {
  const currentRevision = flowRevision(flow);
  const supplied = expectedRevision === undefined || expectedRevision === null || expectedRevision === ""
    ? null : Number(expectedRevision);
  const running = state?.running;
  const runningRevision = Number(running?.flowRevision);
  const contextRevision = Number.isInteger(supplied) ? supplied : (Number.isInteger(runningRevision) ? runningRevision : currentRevision);
  if (contextRevision === currentRevision) return;
  const previousFingerprint = running?.fingerprints?.[nodeId];
  if (!previousFingerprint || previousFingerprint !== executionFingerprint(flow, nodeId)) {
    throw new StaleWorkflowError(
      `Workflow changed from rev${contextRevision} → rev${currentRevision}. Discard stale completion and run: af next ${flow.id}`,
      { nodeId, fromRevision: contextRevision, toRevision: currentRevision }
    );
  }
}

export function completeNode(flow, rawState, nodeId, { result, expectedRevision } = {}) {
  const node = (flow?.nodes ?? []).find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new StaleWorkflowError(`Node ${nodeId} no longer exists in ${flow?.id ?? "workflow"}. Run af next again.`, {
      nodeId, toRevision: flowRevision(flow)
    });
  }
  if (!isExecutableNode(node)) {
    if (node.kind === "input") throw new Error("Input 节点是隐式完成的，不能重复标记完成");
    if (node.kind === "condition" || node.kind === "merge") {
      throw new Error(`${node.kind} node ${nodeId} is executed automatically by Runtime and cannot be marked done manually`);
    }
    throw new Error(`Node ${nodeId} is not an executable Agent step`);
  }
  let compiled = compileExecution(flow, rawState);
  assertFreshCompletion(flow, compiled.state, nodeId, expectedRevision);
  const status = compiled.nodeStatus.get(nodeId)?.status;
  if (status !== "ready" && status !== "done") {
    const waiting = compiled.blocked.get(nodeId) ?? [];
    const detail = waiting.length ? `; waiting for ${waiting.join(", ")}` : "";
    throw new Error(`Node ${nodeId} is not READY (status=${status ?? "unknown"}${detail})`);
  }
  if (result !== undefined) compiled.state.results[nodeId] = result;
  if (!compiled.state.done.includes(nodeId)) compiled.state.done.push(nodeId);
  compiled.state.running = null;
  compiled = compileExecution(flow, compiled.state);
  return compiled;
}

export function setNodeResult(flow, rawState, nodeId, result) {
  const node = (flow?.nodes ?? []).find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} does not exist`);
  if (node.kind === "condition" || node.kind === "merge") {
    throw new Error(`${node.kind} node ${nodeId} result is owned by Runtime`);
  }
  let state = invalidateNodes(flow, rawState, [nodeId], { includeRoots: false });
  state.results[nodeId] = result;
  return compileExecution(flow, state);
}

export function undoNode(flow, rawState, nodeId) {
  const node = (flow?.nodes ?? []).find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} does not exist`);
  if (node.kind === "input") throw new Error("Input 节点是隐式完成的，不能撤销完成状态");
  if (!isExecutableNode(node)) throw new Error(`Node ${nodeId} is automatic and cannot be undone manually`);
  const state = invalidateNodes(flow, rawState, [nodeId], { includeRoots: true });
  state.running = null;
  return compileExecution(flow, state);
}

export function reconcileAfterFlowChange(previousFlow, nextFlow, rawState = {}) {
  const previousState = normalizeExecutionState(previousFlow ?? nextFlow, rawState);
  const nextNodeById = new Map((nextFlow?.nodes ?? []).map((node) => [node.id, node]));
  const previousNodeIds = new Set((previousFlow?.nodes ?? []).map((node) => node.id));
  const stable = new Set();
  for (const [nodeId] of nextNodeById) {
    if (!previousNodeIds.has(nodeId)) continue;
    if (executionFingerprint(previousFlow, nodeId) === executionFingerprint(nextFlow, nodeId)) stable.add(nodeId);
  }
  const nextState = {
    ...previousState,
    flowRevision: flowRevision(nextFlow),
    done: previousState.done.filter((id) => stable.has(id) && isExecutableNode(nextNodeById.get(id))),
    results: Object.fromEntries(Object.entries(previousState.results ?? {}).filter(([id]) => stable.has(id))),
    gates: {},
    edgeStates: {},
    skipped: [],
    // Preserve the old execution context. completeNode compares its fingerprint against the new graph.
    running: previousState.running ?? null
  };
  return compileExecution(nextFlow, nextState);
}

export function executionProgress(flow, state) {
  const executable = (flow?.nodes ?? []).filter(isExecutableNode);
  const done = new Set(normalizeExecutionState(flow, state).done);
  return { done: executable.filter((node) => done.has(node.id)).length, total: executable.length };
}
