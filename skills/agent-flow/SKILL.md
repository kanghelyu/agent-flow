---
name: agent-flow
description: >-
  Design, validate, edit, visualize, and execute AgentFlow Markdown-first workflows
  with deterministic Boolean gates. Use when a task benefits from explicit boxes,
  arrows, branching, parallel work, resumable progress, or when the user asks to
  create/modify/run a workflow graph in AgentFlow.
---

# AgentFlow - Agent Usage Guidelines

This skill is not merely for drawing an attractive diagram. Your responsibility is to turn the user's task into an **executable, verifiable, resumable** workflow. Ordinary dependency graphs must remain deterministic, and every explicit control loop must specify an exit condition, maximum attempt count, or manual stop mechanism.

## 0. Confirm That AgentFlow Is Available First

Prefer running:

```bash
af --version
af doctor
```

If `af` does not exist:

### macOS / Linux

Run this in the AgentFlow repository or extracted directory:

```bash
bash install.sh
```

### Windows PowerShell

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

The installer installs the CLI, Studio, and skill. The desktop pet is optional; an Electron installation failure must not block core work. After installation, run:

```text
af --version
af doctor --json
```

If the current Agent did not discover this skill automatically, copy `skills/agent-flow/` to the applicable directory:

- ZCode: `~/.zcode/skills/agent-flow`
- Claude Code: `~/.claude/skills/agent-flow`
- Codex: `$CODEX_HOME/skills/agent-flow`, or `~/.codex/skills/agent-flow` if it is unset

Without a global `af`, invoke it directly:

```bash
node /absolute/path/to/agent-flow/bin/af.mjs --version
node /absolute/path/to/agent-flow/bin/af.mjs doctor --json
```

Do not block core work because the desktop pet or Electron is unavailable. The CLI plus browser mode via `af studio --no-open` provides full functionality.

### Three-Layer Runtime Model

- CLI: manages Markdown workflows. Its default data root is `~/.agent-flow`, overridable with `AF_HOME` or `--root`.
- Studio: a local HTTP/SSE browser UI. It defaults to `127.0.0.1:4317`, adjustable with `AF_STUDIO_PORT` or `af studio --port`.
- Desktop pet: an optional Electron overlay. Its settings are written to Electron's platform userData directory, not the CLI workflow directory.

Launch the desktop pet:

```bash
~/.agent-flow/studio-pet/run-pet.sh
```

Windows:

```powershell
& "$HOME\.agent-flow\studio-pet\run-pet.ps1"
```

On Linux, transparent windows, tray support, and always-on-top behavior depend on the X11/Wayland desktop environment. When troubleshooting, first verify core functionality with `af studio --no-open`.

## 1. Mental Model: Boxes, Arrows, and Gates

### Boxes (Nodes)

A box represents a work unit with a **clear state, completion condition, and acceptance criteria**.

Common kinds:

- `input`: the workflow entry point. It should express only that the task has started or input is ready; do not put extensive execution work here.
- `agent`: an ordinary execution step, suitable for research, code changes, documentation, testing, and similar work.
- `mapAgent`: repeats the same task over multiple independent objects, such as checking five modules separately.
- `condition`: a deterministic logical gate. It is **executed automatically by the Runtime** and is never returned to an Agent by `af next`.
- `merge`: joins multiple execution paths into a subsequent step. It is also handled automatically by the Runtime and does not need manual `done`.
- `output`: the final delivery or acceptance exit.

### Arrows (Edges)

Arrows express **execution dependencies**: `A -> B` means B depends on A.

Do not use arrows to express:

- "might be related"
- "might be done later"
- "is merely placed later visually"

Connect nodes only when a real dependency exists.

### Logical Gates (Condition Gates)

Logical gates decide which branches to activate from upstream results. A gate's judgment must be **deterministic**; never make it infer meaning from a natural-language statement.

Incorrect:

```json
{ "predicate": "the user appears satisfied" }
```

Correct approach:

1. First add an Agent node: "Determine whether acceptance passed, and output JSON: `{"approved": true|false}`"
2. Feed that Boolean result into `ifElse`
3. Gates use only `truthy` / `falsy` / `nonEmpty`

---

# 2. When to Create a Workflow

Create one when:

- the task has more than three distinct stages;
- a dependency means B can begin only after A is complete;
- there are parallel subtasks;
- there is acceptance, rollback, or conditional branching;
- the user asks for a flowchart, boxes, arrows, or logical gates;
- the task may span multiple sessions and needs resumable progress;
- multiple Agents or subagents need to share one deterministic plan.

You do not need one for:

- a one-off question and answer;
- a small change completed by one command;
- a plain discussion or simple list with no execution dependencies.

Default principle: **if 4-8 boxes can express it, do not draw 20 boxes.**

---

# 3. Strict Rules for Creating Nodes

Every execution node must satisfy all of the following:

1. **One objective**: a node performs one primary task.
2. **Can end**: it has an explicit completion condition.
3. **Can be accepted**: another person can determine whether it is complete.
4. **Clear inputs**: specify the upstream artifacts it depends on.
5. **Clear outputs**: specify the files, conclusions, Boolean values, or reports it produces.
6. **Do not hide a gate in an ordinary node**: if the later path truly depends on true versus false, create an explicit condition.
7. **Do not split dozens of mechanical actions into dozens of nodes**: tightly coupled work in a phase can belong in one STEP.md.

Use a "verb + object" pattern for node names:

- `Analyze the installation environment`
- `Fix desktop-pet startup`
- `Run automated tests`
- `Accept the release package`

Avoid:

- `Step 2`
- `Handle it`
- `Other`
- `Continue`

---

# 4. Strict Rules for Creating Arrows

## 4.1 Ordinary Dependencies

If B must wait for A to finish:

```text
A --> B
```

If A and B can run at the same time, do not draw `A -> B`. Connect each from a shared upstream node instead:

```text
      /-> A -\
Start |       |-> Merge -> C
      \-> B -/
```

## 4.2 Explicit Control Loops Are Allowed

AgentFlow allows you to model "check fails -> fix -> check again" as an explicit control loop. A loop must have a clear state transition and exit path. The Runtime propagates in a stable order for a finite number of rounds; if it does not converge, it remains waiting rather than running forever.

```text
Execute -> Check result -> IF/ELSE
                         |- true  -> Continue
                         \- false -> Fix -> Return to check
```

A loop is not a replacement for ordinary DAG dependencies. Parallel branches should still use Merge, and every loop must document an exit condition, maximum attempt count, or manual stop mechanism in Markdown.

## 4.3 Rejoin After Branching

When multiple branches must eventually enter the same stage, use a `merge` node to join them explicitly.

Do not direct multiple branches into an ordinary Agent node without explanation, unless that node truly must wait until all incoming edges complete.

---

# 5. Complete Logical-Gate Rules

The only permitted gate types are:

```text
ifElse
and
or
not
nand
nor
xor
xnor
```

The only permitted predicates are:

```text
truthy
falsy
nonEmpty
```

**Natural-language predicates are prohibited.**

## 5.1 IF / ELSE

Purpose: one input and two mutually exclusive branches.

Hard rules:

- exactly **one incoming edge**
- `predicate` is normally `truthy`
- the true branch uses `sourceHandle = "true"`
- the false branch uses `sourceHandle = "false"`
- true may connect to at most one target
- false may connect to at most one target

Example:

```text
Run tests -> Tests pass? (IF/ELSE)
                       |- true  -> Package
                       \- false -> Fix report
```

If a test tool does not return a Boolean, first add an Agent step to normalize its result to true or false.

## 5.2 NOT

Purpose: negate one Boolean input.

Hard rules:

- exactly **one incoming edge**
- do not use NOT as a substitute for "ELSE"; prefer `ifElse` for mutually exclusive branches

## 5.3 AND

Purpose: true only when all conditions are satisfied.

Hard rules:

- at least **two incoming edges**

Typical case:

```text
Code tests pass -----+
Documentation passes +-> AND -> Ready to release
Security scan passes -+
```

## 5.4 OR

Purpose: true when any condition is satisfied.

Hard rules:

- at least **two incoming edges**

## 5.5 NAND / NOR

- `NAND = NOT(AND(...))`
- `NOR = NOT(OR(...))`

Use these only when they substantially reduce graph complexity. For typical users, prefer AND/OR with clear labels; do not use NAND/NOR merely for sophistication.

## 5.6 XOR / XNOR

AgentFlow uses deterministic Boolean semantics:

- XOR: an odd number of true inputs -> true
- XNOR: an even number of true inputs -> true

This is not the natural-language approximation that "only one may be true." Confirm that this is the intended semantics before designing the flow.

---

# 6. How to Create a Simple Linear Workflow

The shortest path is:

```bash
af create "Fix the login issue" \
  --desc "Identify the cause, implement the fix, and pass tests" \
  --steps "Reproduce issue;Identify root cause;Implement fix;Run tests;Final acceptance"
```

Then:

```bash
af validate <flow-id>
af studio
```

`af create --steps` is appropriate for a purely linear flow. Once you need gates, parallelism, or complex topology, use Studio or import complete JSON.

---

# 7. How to Create Boxes and Arrows in Studio

Launch:

```bash
af studio
```

## Create a Node

Choose from the bottom toolbar:

- Input
- Agent
- Map Agent
- Condition
- Merge
- Output

After creating it:

1. Click the node
2. Edit its name/STEP.md in the right-side inspector
3. Clearly describe the work, inputs, outputs, and acceptance criteria for that node

## Create an Arrow

1. Begin dragging from the connection point on the right side of the source node
2. Drag to the target node
3. Release to create the connection
4. If the source node is IF/ELSE, select the yes/no branch
5. Click "Validate" after creating the connection

Note: **creating a temporarily unconnected node is an allowed editing intermediate state, but strict validation must pass before delivery.**

## Delete

- Select an arrow -> Delete / delete from the inspector
- Select a node -> Delete
- Delete an entire workflow -> the top "Delete Workflow" button (moves it to `<root>/trash/`, where it can be restored manually)
- Before deleting a node, confirm that it will not leave behind a meaningless isolated branch

## Auto-Arrange

After completing the main topology of a complex graph, use "Arrange Layout" and then make manual adjustments. Arrangement changes coordinates only, not topology, and also works for graphs containing loops or incomplete work. Do not use placement to express dependencies; only arrows establish dependencies.

---

# 8. Complete JSON Topology Rules

Use this when you need to generate a complex workflow programmatically:

```bash
af create --json flow.json
```

Basic structure:

```json
{
  "id": "example",
  "name": "Example",
  "nodes": [
    {
      "id": "input",
      "kind": "input",
      "position": { "x": 80, "y": 120 },
      "data": { "label": "Start" }
    },
    {
      "id": "work",
      "kind": "agent",
      "position": { "x": 320, "y": 120 },
      "data": { "label": "Perform work" }
    },
    {
      "id": "output",
      "kind": "output",
      "position": { "x": 560, "y": 120 },
      "data": { "label": "Deliver" }
    }
  ],
  "edges": [
    { "id": "e1", "source": "input", "target": "work" },
    { "id": "e2", "source": "work", "target": "output" }
  ]
}
```

IF/ELSE example:

```json
{
  "id": "gate",
  "kind": "condition",
  "position": { "x": 560, "y": 120 },
  "data": {
    "label": "Pass?",
    "gateType": "ifElse",
    "valuePath": "$.passed",
    "predicate": "truthy"
  }
}
```

Outgoing edges:

```json
[
  {
    "id": "pass",
    "source": "gate",
    "target": "publish",
    "sourceHandle": "true",
    "label": "Yes"
  },
  {
    "id": "fail",
    "source": "gate",
    "target": "fix",
    "sourceHandle": "false",
    "label": "No"
  }
]
```

After generating JSON, you **must** run:

```bash
af create --json flow.json
af validate <new-flow-id>
```

Do not skip validation.

---

# 9. How to Write STEP.md

Write every Agent, Map Agent, and Output step as work instructions that the current Agent can execute independently.

Recommended structure:

```md
# Objective

Fix the issue that prevents the desktop pet from being dragged during startup.

## Inputs

- studio-pet/main.js
- studio/index.html

## Work

- The window must appear immediately on startup
- Initialize the Studio service in the background
- Display an error on startup failure while keeping the pet draggable

## Acceptance

- The window is visible within one second of startup
- The pet remains draggable during startup
- The final pet UI automatically replaces the startup UI after Studio starts
- Automated tests pass

## Outputs

- Modified code
- Test results
```

Avoid writing only "fix the desktop pet" in STEP.md.

---

# 10. Execute a Workflow: Required Loop

The AgentFlow Runtime **does not perform Agent steps for you**, but it automatically executes Condition / Merge and persists branch state. You may execute only READY nodes returned by `af next`.

Standard loop:

```bash
af next <id> --json
```

The response includes the current `flowRevision`, READY nodes, gate state, `edgeStates`, and `skipped`. Then:

1. Read the STEP.md for each READY node.
2. Actually complete that step.
3. Write key artifacts to the step workspace.
4. Produce structured JSON according to STEP.md's output contract.
5. Commit using the revision returned by that same `af next` call:

```bash
af done <id> <nodeId> --result '{"passed":true}' --revision <flowRevision>
```

After `af done` succeeds, the Runtime immediately:

- saves `results[nodeId]`;
- evaluates resolvable Conditions automatically;
- writes gate outgoing edges as `active / inactive / pending`;
- writes inactive branches to `skipped`;
- handles Merge automatically;
- recalculates the next batch of READY Agent nodes.

If a result must be added later, use:

```bash
af result <id> <nodeId> '{"passed":true}'
```

View status at any time:

```bash
af status <id>
```

If a node was marked incorrectly:

```bash
af undo <id> <nodeId>
```

`undo` clears that node and the downstream completion/result state affected by it. **Never mark a node done before the work is complete, and never manually mark Condition/Merge nodes done.**

If Studio changes the current node or one of its upstream nodes while an Agent is working, the old submission returns `STALE_WORKFLOW`. Discard that old submission and run `af next <id>` again. If only a branch unrelated to the current node changed, the Runtime uses its execution fingerprint to determine that the current node may still complete normally.

---

# 11. How to Execute Logical Gates

A gate is not an ordinary step that a model needs to "execute," and **you do not need to run `af evaluate` manually to advance the flow**.

The upstream Agent must submit a structured result through `af done --result`. For example, STEP.md may specify:

```json
{
  "passed": true
}
```

Condition configuration:

```json
{
  "kind": "condition",
  "data": {
    "gateType": "ifElse",
    "valuePath": "$.passed",
    "predicate": "truthy"
  }
}
```

The Runtime automatically extracts `$.passed`, applies the predicate, computes the Boolean value, and activates the correct branch. When `valuePath` is absent, it defaults to `result.value` if the result object has a `value` field; otherwise, it applies the predicate directly to the entire result.

`af evaluate <id> --values '{...}'` remains available, but it performs only a **diagnostic, stateless** truth-table check. It does not modify `state.json`; do not treat it as part of the formal execution loop.

---

# 12. Parallel-Task Rules

If two steps have no dependency, they should run in parallel:

```text
         /-> Frontend check -\
Input ---|                   |-> Merge -> Acceptance
         \-> Backend check --/
```

Running `af next` can return multiple ready steps; you may process them concurrently.

Do not force serialization solely for visual ordering.

---

# 13. Map Agent Rules

Use Map Agent when "one kind of operation applies to a set of independent objects."

Appropriate for:

- checking multiple modules
- analyzing multiple files
- running the same set of rules on multiple targets

Not appropriate for:

- subtasks with entirely different logic
- subtasks with strong dependencies between them

In those cases, multiple ordinary Agent nodes are clearer.

---

# 14. Workflow Health

Before delivery, you must run:

```bash
af validate <id>
```

Studio and the desktop pet show a workflow-health indicator:

- **green**: strict structural validation passed
- **red**: a structure, gate, or connectivity problem exists
- **gray**: no workflow is available to validate

Do not keep pretending the flow has been designed when you see a red indicator. First run:

```bash
af validate <id>
```

Then fix each reported error.

---

# 15. Common Errors and Fixes

## unreachable nodes

Meaning: one or more nodes cannot be reached from the entry point.

Resolution:

- add an edge;
- or remove the unused node;
- do not add a business-meaningless edge just to make validation green.

## cycle / cyclic

Meaning: an explicit control loop is present.

Resolution:

- control loops such as "check -> fix -> return to check" are allowed when they have a clear exit condition;
- document the exit condition, maximum attempt count, or manual stop mechanism in WORKFLOW.md;
- the Runtime propagates in a stable order for a finite number of rounds; if it does not converge, it remains waiting rather than running forever.

## Incorrect IF/ELSE Incoming-Edge Count

IF/ELSE must have exactly one input.

If you need multiple judgments:

- first aggregate them with AND/OR or similar;
- then feed the aggregate result into IF/ELSE.

## Insufficient Aggregate-Gate Inputs

AND/OR/NAND/NOR/XOR/XNOR need at least two inputs.

With only one input, an aggregate gate is normally unnecessary.

## Invalid predicate

Only these are allowed:

```text
truthy / falsy / nonEmpty
```

If you wrote natural language, change the flow so the upstream Agent outputs a structured value first.

## Ambiguous Branch Semantics

Give condition nodes and branch targets clear names:

- `Tests pass?`
- true -> `Prepare release`
- false -> `Generate repair checklist`

Do not use `Condition 1` / `Branch 2`.

---

# 16. When Modifying an Existing Workflow

First read:

```bash
af read <id>
af status <id>
af validate <id>
```

Then modify it.

Principles:

- preserve the semantics of completed steps unless the user explicitly requests a redesign;
- validate again after changing topology;
- after manually editing Markdown, run this when necessary:

```bash
af render <id>
```

---

# 17. Final Delivery Checklist

Before delivery, confirm each item:

- [ ] Every node has a clear name
- [ ] No meaningless isolated nodes exist
- [ ] Arrows express only real dependencies
- [ ] Every control loop has a clear exit condition, maximum attempt count, or manual stop mechanism
- [ ] IF/ELSE has exactly one input
- [ ] Every aggregate gate has at least two inputs
- [ ] No predicate uses natural language
- [ ] True/false branch meanings are clear
- [ ] Parallel tasks have not been incorrectly serialized
- [ ] STEP.md includes inputs, objective, acceptance criteria, and outputs
- [ ] `af validate <id>` passes
- [ ] For execution tasks, completion state matches the actual work

---

# 18. Command Reference

```bash
af create <name> --steps "A;B;C"
af create --json flow.json
af list
af read <id>
af validate <id>
af evaluate <id> --values '{"node":true}'   # Diagnostics only; does not advance the Runtime
af next <id> --json
af done <id> <nodeId> --result '{"value":true}' --revision <rev>
af result <id> <nodeId> '{"value":true}'
af undo <id> <nodeId>
af status <id>
af render <id>
af delete <id> --yes
af studio
af doctor
```

Default global storage:

```text
~/.agent-flow
```

Recommended project-level workflow storage:

```bash
af create "Project workflow" --steps "A;B;C" --root .af
```

Or:

```bash
AF_HOME=.af af ...
```

Markdown/flow definitions may be committed to version control. Whether to commit runtime `state.json` depends on the project's collaboration model.
