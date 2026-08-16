import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const af = join(import.meta.dirname, "..", "bin", "af.mjs");

async function makeRoot() {
  return mkdtemp(join(tmpdir(), "agent-flow-test-"));
}

test("create builds a linear workflow with documents and a valid DAG", async () => {
  const root = await makeRoot();
  const { stdout } = await run("node", [af, "create", "线性演示", "--steps", "调研;实现;验收", "--root", root]);
  assert.match(stdout, /已创建工作流/);
  const flows = await readdir(join(root, "flows"));
  assert.equal(flows.length, 1);
  const id = flows[0];
  const workflow = await readFile(join(root, "flows", id, "WORKFLOW.md"), "utf8");
  assert.match(workflow, /## 执行顺序/);
  assert.match(workflow, /调研/);
  const definition = JSON.parse(await readFile(join(root, "flows", id, "flow.json"), "utf8"));
  assert.equal(definition.nodes.length, 5);
  assert.equal(definition.docRoot, undefined);
  const validation = await run("node", [af, "validate", id, "--root", root]);
  assert.match(validation.stdout, /✓ 结构合法/);
});

test("next/done/status drive resumable execution bookkeeping", async () => {
  const root = await makeRoot();
  await run("node", [af, "create", "执行演示", "--steps", "a;b", "--root", root]);
  const [id] = await readdir(join(root, "flows"));
  const first = await run("node", [af, "next", id, "--root", root]);
  assert.match(first.stdout, /step-01/);
  const done = await run("node", [af, "done", id, "step-01", "--root", root]);
  assert.match(done.stdout, /已完成 step-01/);
  assert.match(done.stdout, /step-02/);
  const status = await run("node", [af, "status", id, "--root", root]);
  assert.match(status.stdout, /1\/3 步完成/);
  const again = await run("node", [af, "next", id, "--root", root]);
  assert.match(again.stdout, /step-02/);
  await run("node", [af, "undo", id, "step-01", "--root", root]);
  const undone = await run("node", [af, "status", id, "--root", root]);
  assert.match(undone.stdout, /0\/3 步完成/);
});

test("imported gate flow evaluates IF/ELSE branches deterministically", async () => {
  const root = await makeRoot();
  const gateFlow = {
    id: "gate-flow",
    name: "gate",
    version: 1,
    nodes: [
      { id: "input", kind: "input", position: { x: 0, y: 0 }, data: { label: "输入" } },
      { id: "judge", kind: "agent", position: { x: 1, y: 0 }, data: { label: "判断", prompt: "true/false" } },
      { id: "gate", kind: "condition", position: { x: 2, y: 0 }, data: { label: "门", gateType: "ifElse", predicate: "truthy" } },
      { id: "yes", kind: "agent", position: { x: 3, y: 0 }, data: { label: "是", prompt: "yes" } },
      { id: "no", kind: "agent", position: { x: 3, y: 1 }, data: { label: "否", prompt: "no" } },
      { id: "output", kind: "output", position: { x: 4, y: 0 }, data: { label: "输出" } }
    ],
    edges: [
      { id: "e1", source: "input", target: "judge" },
      { id: "e2", source: "judge", target: "gate" },
      { id: "e3", source: "gate", target: "yes", sourceHandle: "true" },
      { id: "e4", source: "gate", target: "no", sourceHandle: "false" },
      { id: "e5", source: "yes", target: "output" },
      { id: "e6", source: "no", target: "output" }
    ],
    inputs: ["input"],
    outputs: ["output"]
  };
  const file = join(root, "gate.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, JSON.stringify(gateFlow), "utf8");
  await run("node", [af, "create", "--json", file, "--root", root]);
  const [id] = await readdir(join(root, "flows"));
  const evaluation = JSON.parse((await run("node", [af, "evaluate", id, "--values", '{"judge":true}', "--root", root])).stdout);
  assert.equal(evaluation.ready, true);
  assert.deepEqual(evaluation.activeTargets, ["yes"]);
  const no = JSON.parse((await run("node", [af, "evaluate", id, "--values", '{"judge":false}', "--root", root])).stdout);
  assert.deepEqual(no.activeTargets, ["no"]);
});

test("delete requires --yes and archives to trash", async () => {
  const root = await makeRoot();
  await run("node", [af, "create", "删除演示", "--steps", "x", "--root", root]);
  const [id] = await readdir(join(root, "flows"));
  await assert.rejects(
    run("node", [af, "delete", id, "--root", root]),
    /确认删除/
  );
  await run("node", [af, "delete", id, "--yes", "--root", root]);
  const remaining = await readdir(join(root, "flows"));
  assert.equal(remaining.length, 0);
  const trash = await readdir(join(root, "trash"));
  assert.equal(trash.length, 1);
});
