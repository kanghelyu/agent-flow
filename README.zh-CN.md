# AgentFlow（`af`）— Markdown 优先的可视化工作流，任何编码代理都能用

[English](README.md) · [简体中文](README.zh-CN.md)

把长任务变成**分步 Markdown 工作流**：确定性布尔门 + 零依赖 CLI + 实时可视化画布（Studio）+ 可选桌面悬浮宠物窗。ZCode、Claude Code、Codex CLI、DeepSeek Harness、甚至裸 shell 都能用。

```
af next <id> → 读 STEP.md → 在当前会话干活 → af done <id> <nodeId> → 循环 → af validate
```

![Studio 暗色主题](docs/shots/en-dark.png)

- **Markdown 唯一事实来源**——每个步骤都是一份可读、可改、可 diff、可提交的 `STEP.md`；`flow.json` 只是派生元数据，不是数据库锁定。
- **确定性逻辑门**——`ifElse / and / or / not / nand / nor / xor / xnor`，谓词只允许 `truthy / falsy / nonEmpty`。分支走向由真值表决定，绝不由模型临场发挥。
- **可视化 Studio**——`af studio` 在 `127.0.0.1` 起一个交互画布：拖节点、连线选分支、内联编辑 `STEP.md`、求值逻辑门，Agent 在终端改文件时画布经 SSE 约 1 秒自动刷新。
- **桌面宠物模式**——常驻置顶迷你卡片（流程名 + 进度 + 下一步），点击展开完整画布。检测到 clawd-on-desk 已装的 Electron 就直接复用（零新增下载），否则退回浏览器应用模式。
- **零依赖、三平台**——纯 Node ESM（≥ 18），无原生模块、无平台调用，中文流程名没问题。macOS / Linux / Windows。

![浅色主题 + 中文界面](docs/shots/zh-light.png)

## 为什么需要它

代理干长任务会「失忆」：计划活在易失的对话上下文里，进度全凭一张嘴，分支逻辑就是一句提示词。AgentFlow 把计划落盘成可审阅的 Markdown，把进度放进显式的 `done` 簿记，把分支交给静态校验器可证明的门语义（无环、连通、门元数、真值表确定性）。

它是 [DeepSeek Flow](https://github.com/kanghelyu/dsh-deepseek-flow)（DeepSeek Harness 的可视化工作流编辑插件）的可移植内核：五个模块两边逐字相同，因此 `flow.json`、`WORKFLOW.md` 结构块、门语义**完全互通**——dsh 导出的 JSON 用 `af create --json` 导入；af 的 flow.json 交给 dsh 的 `flow_put` 直接在画布打开。通用版额外补上无会话概念代理需要的东西：执行簿记（`next` / `done` / `undo` / `status`）、独立 Studio 服务、以及教会任何 agent 门规则的自带技能。

## 安装

**macOS / Linux**

```bash
bash install.sh          # CLI → ~/.agent-flow，技能 → 检测到的代理目录
```

**Windows**（PowerShell）

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

安装器会生成 `af.cmd` shim 并尝试放进 PATH；否则把 `%USERPROFILE%\.agent-flow\bin` 加入 PATH。

要求 Node ≥ 18（test 里 `import.meta.dirname` 需 20.11+）。Windows 上 `--values` 的 JSON 引号建议用 PowerShell；启动用 `af.cmd` 或 `node af.mjs`（cmd 不认 shebang）。

## 快速上手

```bash
af create release-check --steps "lint;tests;changelog;publish"
af next release-check          # 打印就绪步骤 + STEP.md 路径
#   ……让代理执行这一步……
af done release-check lint
af status release-check
af evaluate <id> --values '{"approved":true}'   # 门真值求值
```

存储根默认 `~/.agent-flow`，`--root` / `AF_HOME` 覆盖；项目内工作流推荐 `--root .af`（提交 Markdown、忽略 state.json）。

## 命令速查

| 命令 | 用途 |
| --- | --- |
| `af create <name> --steps "a;b;c"` | 线性工作流（默认四步脚手架） |
| `af create --json flow.json` | 导入完整定义（含逻辑门），兼容 dsh 导出 |
| `af list` / `af read <id>` | 列表与进度 / 总纲 + 全部 STEP.md + 逻辑契约 |
| `af validate <id>` | 无环、连通、门语义校验（不调用模型） |
| `af evaluate <id> --values '{...}'` | 门真值求值与激活目标 |
| `af next` / `af done` / `af undo` | 执行导航与簿记 |
| `af status <id>` | 完成/待办/阻塞总览 |
| `af render <id>` | 手工改 Markdown 后重建结构块 |
| `af delete <id> --yes` | 归档删除（trash 可恢复） |
| `af studio [--app] [--port N]` | 可视化画布（默认 127.0.0.1:4317） |

## Studio — 可视化画布

```bash
af studio              # 零依赖本地服务 + 默认浏览器打开
af studio --app        # Chrome 应用模式（独立窗口无地址栏）
```

画布与 DeepSeek Flow 同一套视觉与交互语言：节点卡片/类型色标、贝塞尔箭头与「是/否」分支标签、逻辑门 chip + 真值公式、进度徽标、⌘/Ctrl+滚轮缩放、双指平移、拖框连线（IF/ELSE 自动弹分支选择器）、右侧检查器直接编辑 STEP.md 即时落盘、求值面板、SSE 实时同步。所有拓扑修改先跑确定性校验再写盘——环、门元数违规、重复连接当场拦截；「不可达节点」作为编辑中间态放行，由「校验」按钮与 `af validate` 严格把关。界面内置中英切换与浅暗双主题（按浏览器记忆）。

![门求值](docs/shots/en-logic.png)

### 桌面宠物（悬浮窗）

```bash
studio-pet/run-pet.sh        # macOS 也可双击 run-pet.command
```

常驻置顶迷你卡片点击展开为完整画布窗口；自动复用 clawd-on-desk 已安装的 Electron 运行时（零新增下载），Studio 服务以进程内方式运行（无子进程）。深度集成 clawd（托管进 clawd 宠物窗、LaunchAgent 开机自启）见 [`studio-pet/HOST-WITH-CLAWD.md`](studio-pet/HOST-WITH-CLAWD.md)。没有 Electron 时，除悬浮窗外的一切功能照常走 `af studio` 浏览器模式（三平台可用）。

## 逻辑门硬规则（与 dsh 版一致）

- 门类型：`ifElse / and / or / not / nand / nor / xor / xnor`；谓词只能是 `truthy / falsy / nonEmpty`。
- **不要**把自然语言写进 predicate。先让上游 agent 步骤输出布尔值，再连 `predicate: "truthy"` 的门。
- `ifElse`/`not` 恰好一个入边；聚合门至少两个入边；图必须无环。

## 自带代理技能

`skills/agent-flow/SKILL.md` 教会任何支持技能的代理（ZCode / Claude Code / Codex CLI）何时建流程、门 JSON 契约、每种情形该用哪条 `af` 命令、常见报错对照表。安装器会复制到检测到的代理技能目录。

## 测试

```bash
node --test test/cli.test.mjs test/studio.test.mjs
```

## 卸载

```bash
rm -rf ~/.agent-flow ~/.zcode/skills/agent-flow ~/.claude/skills/agent-flow ~/.codex/skills/agent-flow /usr/local/bin/af
```

MIT License。官网：<https://agentflow.kanghelyu.org> · 相关项目：[dsh-deepseek-flow](https://github.com/kanghelyu/dsh-deepseek-flow)
