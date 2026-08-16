---
name: agent-flow
description: >-
  Build and execute Markdown-first step workflows with the af CLI: deterministic
  Boolean gates (IF/ELSE, AND, OR, NOT, NAND, NOR, XOR, XNOR), acyclic
  validation, per-step STEP.md workspaces, and resumable execution bookkeeping.
  Use when the user asks for a workflow, pipeline, multi-step plan with gates,
  or "把流程做成图/按步骤推进/可恢复的多步任务".
---

# AgentFlow 工作流（af CLI）

用户要求构建、导入或**按步骤执行**多步骤工作流时使用本技能。需求明确时直接执行，不要反复确认。

## 核心模型

- 每个工作流 = 一个目录：`WORKFLOW.md` 总纲 + `NN-slug/STEP.md` 每步工作区 + `flow.json`（机器定义）+ `state.json`（执行进度）。
- **Markdown 是唯一事实来源**：你和用户都直接读改 Markdown；`af render` 可在手工改动后重建总纲中的结构块。
- `af` 只做确定性校验、布尔门求值和进度簿记，**不执行任何步骤**——真正干活的是你（当前会话）。
- flow.json 与 DeepSeek Flow（dsh 插件）完全互通：dsh 导出的 JSON 可 `af create --json` 导入，af 的 flow.json 可直接交给 dsh `flow_put`。

## 构建工作流

```bash
af create "名称" --desc "目标与验收" --steps "第一步;第二步;第三步"
af validate <id>
```

需要分支/逻辑门时用 `--json` 导入完整定义（节点带 position；门节点 kind=condition）。八种门：`ifElse / and / or / not / nand / nor / xor / xnor`；IF/ELSE 出边 `sourceHandle` 分别为 `"true"` / `"false"`，其他门出边 sourceHandle = 门名。

## 逻辑门硬规则（与 dsh 版一致）

- `predicate` 与 `inputPredicates` 的值只能是 `truthy`、`falsy`、`nonEmpty`，**禁止自然语言**。
- 需要理解语义（如「用户是否确认」）时：先放一个 agent 步骤让它明确输出布尔 `true`/`false`，再连到 `predicate: "truthy"` 的门。
- `ifElse`/`not` 恰好一个入边；聚合门（and/or/nand/nor/xor/xnor）至少两个入边。
- 图必须无环；重试建模为有界重试步骤或失败终止分支。

```bash
af evaluate <id> --values '{"judge": true}'   # 确定性求值，输出激活目标
```

## 执行循环（核心）

```bash
af next <id>        # 拿到可执行步骤（含可并行集合）
# → 读对应 STEP.md → 在当前会话完成工作 → 产物/结论写回该步骤目录
af done <id> <nodeId>   # 标记完成，自动提示下一步
af status <id>      # 随时查看 完成/待办/阻塞
```

遇到条件门：先完成上游 agent 步骤拿到布尔结果，用 `af evaluate` 确认激活分支，只走激活分支的后续步骤。全部完成后跑 `af validate <id>` 收尾，并向用户报告进度总览。

## 其他命令

```bash
af list                 # 全部工作流与进度
af read <id> [--json]   # 总纲+全部 STEP.md+逻辑契约（供你读取）
af render <id>          # 手工改 Markdown 后重建结构块
af delete <id> --yes    # 归档删除（trash 可恢复）
```

用户想看流程图时，提示运行 `af studio`（本地可视化画布，与终端改动实时同步）。

全局可用 `--root <dir>` 或 `AF_HOME` 指定存储根（默认 `~/.agent-flow`）。项目级工作流建议放在仓库内并用 `--root .af`（记得提交 Markdown，忽略 state.json）。
