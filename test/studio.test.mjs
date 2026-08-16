import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startStudioServer } from "../studio/server.mjs";

const run = promisify(execFile);
const af = join(import.meta.dirname, "..", "bin", "af.mjs");

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-studio-"));
  await run("node", [af, "create", "演示", "--steps", "调研;实现;验收", "--root", root]);
  const handle = await startStudioServer({ root, port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  return { root, handle, base };
}

test("studio serves the canvas page and the flow list", async () => {
  const { handle, base } = await makeServer();
  const page = await fetch(`${base}/`).then((res) => res.text());
  assert.match(page, /AgentFlow Studio/);
  const flows = await fetch(`${base}/api/flows`).then((res) => res.json());
  assert.equal(flows.length, 1);
  assert.equal(flows[0].total, 4);
  assert.equal(flows[0].done, 0);
  await handle.stop();
});

test("detail, done/undo, doc save and evaluate round-trip through the API", async () => {
  const { root, handle, base } = await makeServer();
  const flowsList = await (await fetch(`${base}/api/flows`)).json();
  const [id] = flowsList.map((flow) => flow.id);
  const detail = await (await fetch(`${base}/api/flow/${encodeURIComponent(id)}`)).json();
  assert.equal(detail.nodes.length, 5);
  const firstStep = detail.nodes.find((node) => node.kind === "agent");
  assert.equal(firstStep.ready, true);

  const post = (path, body) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).then((res) => res.json());

  const afterDone = await post(`/api/flow/${encodeURIComponent(id)}/done`, { nodeId: firstStep.id });
  assert.equal(afterDone.progress.done, 1);
  assert.equal(afterDone.nodes.find((node) => node.id === firstStep.id).done, true);

  const saved = await post(`/api/flow/${encodeURIComponent(id)}/doc`, { nodeId: firstStep.id, content: "# 新内容\n\n来自 Studio" });
  assert.match(saved.nodes.find((node) => node.id === firstStep.id).content, /来自 Studio/);

  const undone = await post(`/api/flow/${encodeURIComponent(id)}/undo`, { nodeId: firstStep.id });
  assert.equal(undone.progress.done, 0);

  const evaluation = await (await fetch(`${base}/api/flow/${encodeURIComponent(id)}/evaluate?values=${encodeURIComponent("{}")}`)).json();
  assert.equal(evaluation.ready, true);
  void root;
  await handle.stop();
});

test("topology mutations validate before persisting and reject broken graphs", async () => {
  const { handle, base } = await makeServer();
  const flowsList = await (await fetch(`${base}/api/flows`)).json();
  const [id] = flowsList.map((flow) => flow.id);
  const post = (path, body) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const added = await (await post(`/api/flow/${encodeURIComponent(id)}/node-add`, { kind: "agent", x: 400, y: 120 })).json();
  assert.equal(added.ok, true);
  const newNode = added.detail.nodes.find((node) => node.label === "Agent" && node.position.x === 400);
  assert.ok(newNode, "新增节点应出现在详情里");
  assert.equal(newNode.kind, "agent");

  // 删除唯一的 input 必须被校验拒绝，且磁盘不落盘。
  const inputId = added.detail.nodes.find((node) => node.kind === "input").id;
  const rejected = await post(`/api/flow/${encodeURIComponent(id)}/node-delete`, { nodeId: inputId });
  assert.equal(rejected.status, 400);
  const issues = await rejected.json();
  assert.match(issues.issues.join(" "), /input/i);

  const detailAfter = await (await fetch(`${base}/api/flow/${encodeURIComponent(id)}`)).json();
  assert.ok(detailAfter.nodes.some((node) => node.kind === "input"), "被拒绝的删除不得写盘");

  // 路径穿越直接 400。
  const evil = await fetch(`${base}/api/flow/..%2F..%2Fetc`);
  assert.equal(evil.status, 400);
  await handle.stop();
});
