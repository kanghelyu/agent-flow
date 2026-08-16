"use strict";
// AgentFlow Studio 悬浮窗（宠物模式）。
// 常驻置顶迷你卡片（流程名 + 进度 + 下一步），点击展开为完整画布窗口。
// 运行方式：优先复用 clawd-on-desk 已安装的 Electron 二进制（零新增下载）。
// studio 服务在本进程内启动（动态 import ESM 模块），不派生任何子进程。
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// 端口只接受显式配置的正整数，其余一律回落默认值（防止环境变量注入参数）。
const requestedPort = Number(process.env.AF_STUDIO_PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
  ? requestedPort
  : 4870;
const BASE = `http://127.0.0.1:${PORT}`;
const MINI = { width: 288, height: 122 };
const FULL = { width: 1040, height: 720 };

let win = null;
let tray = null;
let studioHandle = null;

function studioUp() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/flows`, { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function ensureStudio() {
  // 已有独立运行的 af studio 就直接复用；否则在本进程内启动一个。
  if (await studioUp()) return;
  const { startStudioServer } = await import(pathToFileURL(
    path.join(__dirname, "..", "studio", "server.mjs")
  ).href);
  studioHandle = await startStudioServer({ port: PORT });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await studioUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("af studio 未能在本进程内就绪");
}

function loadMini() {
  win.loadURL(`${BASE}/?mode=pet`);
}

function createWindow() {
  win = new BrowserWindow({
    width: MINI.width,
    height: MINI.height,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, "floating");
  loadMini();

  ipcMain.handle("pet-expand", () => {
    win.setSize(FULL.width, FULL.height);
    win.center();
    win.loadURL(`${BASE}/`);
  });
  ipcMain.on("pet-collapse", () => {
    win.setSize(MINI.width, MINI.height);
    loadMini();
  });
  win.on("closed", () => { win = null; });
}

app.whenReady().then(async () => {
  try {
    await ensureStudio();
  } catch (error) {
    console.error(error.message);
    app.quit();
    return;
  }
  createWindow();
  // 1x1 透明占位托盘图标：不引入图片资源也保持跨平台可用。
  tray = new Tray(nativeImage.createFromBuffer(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
    { width: 1, height: 1 }
  ));
  tray.setToolTip("AgentFlow Studio");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "迷你悬浮", click: () => win && loadMini() },
    { label: "退出", click: () => app.quit() }
  ]));
  app.on("activate", () => { if (!win) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => { studioHandle?.stop(); });
