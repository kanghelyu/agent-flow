# 托管到 clawd-on-desk（CC 桌面宠物）

三种由浅入深的集成方式，按需取用。

## 方式一：零改动托管（默认可用）

`run-pet.sh` 自动探测并**复用 clawd-on-desk 安装里的 Electron 二进制**运行悬浮窗：

```bash
bash run-pet.sh        # 或 macOS 双击 run-pet.command
```

不重复下载 Electron、不动 clawd 任何文件；clawd 退出也不影响（二进制独立于其进程）。

## 方式二：加一条 clawd 源码 patch（双击宠物唤起流程画布）

你的 clawd 已经有「双击宠物 → activateAgent」本地 patch（`src/pet-interaction-ipc.js` + `src/main.js` + `src/preload-hit.js` + `src/hit-renderer.js` 四处）。给 AgentFlow 加一个同构入口只需两步：

1. `src/main.js` 注册 IPC（与 `pet-interaction:activate-agent` 并列）：

```js
ipcMain.on("pet-interaction:open-flow-studio", () => {
  const { spawn } = require("node:child_process");
  const runner = require("node:path").join(process.env.HOME,
    ".agent-flow", "studio-pet", "run-pet.sh");
  require("node:fs").access(runner, (error) => {
    if (!error) spawn("/bin/bash", [runner], { detached: true, stdio: "ignore" }).unref();
  });
});
```

2. 触发点任选其一：
   - `src/pet-interaction-ipc.js` 里加一个右键菜单项（`showContextMenu` 的模板中）：`{ label: "流程画布", click: () => sendToRenderer or win.webContents.send(...) }`；
   - 或在 `src/hit-renderer.js` 把「三击宠物」绑定到 `window.hitAPI.openFlowStudio()`（preload 里暴露对应 IPC，与 activateAgent 同款写法）。

⚠️ 与你现有 patch 相同的注意事项：`git pull` 更新 clawd 会覆盖，需重打。

## 方式三：开机自启（LaunchAgent，可选）

```bash
cat > ~/Library/LaunchAgents/dev.agentflow.studio-pet.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.agentflow.studio-pet</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>__AGENT_FLOW_HOME__/studio-pet/run-pet.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
PLIST
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.agentflow.studio-pet.plist
```

把 `__AGENT_FLOW_HOME__` 替换为 agent-flow 安装目录（默认 `~/.agent-flow`，安装器会把 studio-pet 一并复制过去）。

## 浏览器兜底

不需要悬浮窗时，任何平台直接：

```bash
af studio            # 默认浏览器打开
af studio --app      # Chrome 应用模式（无地址栏的独立窗口）
```
