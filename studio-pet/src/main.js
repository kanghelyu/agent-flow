// AgentFlow Pet — main process.
// Shell: pixelpets (MIT, https://github.com/JOhnsonKC201/pixelpets), stripped to
// a cat-only overlay + tray. Added: AgentFlow Studio status polling, hover-reveal
// status bubble/toolbar, right-click size menu.
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const config = require('./config');
const { PATTERN_NAMES } = require('./patterns');

// Optional preview flags (QA): --shot / --state= / --pattern= / --note= / --at=
// / --size= / --shot-output=. Screenshot runs are deliberately independent from
// the live overlay, so visual regression checks never collide with the singleton.
const SHOT = process.argv.includes('--shot');
const SIZE_MIN = 0.2;
const SIZE_MAX = 3;
const stateArg = (process.argv.find((a) => a.startsWith('--state=')) || '').split('=')[1] || '';
const patternArg = (process.argv.find((a) => a.startsWith('--pattern=')) || '').split('=')[1] || '';
const noteArg = (process.argv.find((a) => a.startsWith('--note=')) || '').split('=').slice(1).join('=') || '';
const rawShotSize = Number((process.argv.find((a) => a.startsWith('--size=')) || '').split('=')[1]);
const shotSize = Number.isFinite(rawShotSize) ? Math.max(SIZE_MIN, Math.min(SIZE_MAX, rawShotSize)) : null;
const rawShotOutput = (process.argv.find((a) => a.startsWith('--shot-output=')) || '').split('=').slice(1).join('=');
const shotOutput = rawShotOutput ? path.resolve(rawShotOutput) : path.join(__dirname, '..', '_render.png');
const SHOT_CANVAS = { w: 520, h: 1000 };
const rawShotAt = Number((process.argv.find((a) => a.startsWith('--at=')) || '').split('=')[1]);
const shotAtMs = Number.isFinite(rawShotAt) && rawShotAt >= 0 ? rawShotAt : 700;

// Single-instance: the pet is a singleton (login-launch + a manual start would
// otherwise spawn two overlays, two cursor loops). QA screenshots are isolated
// short-lived windows and therefore do not acquire the live overlay's lock.
const isSecondary = !SHOT && !app.requestSingleInstanceLock();
if (isSecondary) app.quit();

// macOS: a desktop pet belongs in the menu bar, not the Dock or the app switcher.
if (process.platform === 'darwin' && app.dock) app.dock.hide();

// --- AgentFlow Studio bridge -------------------------------------------------
const requestedPort = Number(process.env.AF_STUDIO_PORT);
const PREFERRED_PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 4870;
const POLL_MS = 1800;
let studioBase = null;
let studioStarting = null;
let studioWindow = null;
let studioHandle = null;
let statusTimer = null;
let sizeWindow = null;

function baseFor(port) { return `http://127.0.0.1:${port}`; }
function flowRoot() { return path.resolve(process.env.AF_HOME || path.join(os.homedir(), '.agent-flow')); }

// Local-only JSON helper. `port` must be a finite integer from our own server or
// the fixed PREFERRED_PORT constant; the request always targets the loopback
// host with a fixed pathname list, so no external input can redirect it.
function getJson(port, pathname = '/api/flows', timeout = 1200) {
  const allowedPaths = ['/api/flows', '/'];
  const path = allowedPaths.includes(pathname) ? pathname : '/';
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function studioUp(port) {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return false;
  return Array.isArray(await getJson(port, '/api/flows', 800));
}

function studioResourcePath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'studio'),
    path.join(process.resourcesPath || '', 'studio'),
    path.join(app.getAppPath(), '..', 'studio'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'server.mjs'))) || candidates[0];
}

async function ensureStudio() {
  if (studioStarting) return studioStarting;
  studioStarting = (async () => {
    try {
      if (studioBase && await studioUp(studioHandle?.port ?? PREFERRED_PORT)) return true;
      const preferredBase = baseFor(PREFERRED_PORT);
      if (await studioUp(PREFERRED_PORT)) { studioBase = preferredBase; return true; }
      const { startStudioServer } = await import(pathToFileURL(path.join(studioResourcePath(), 'server.mjs')).href);
      try {
        studioHandle = await startStudioServer({ root: flowRoot(), port: PREFERRED_PORT });
      } catch (error) {
        if (error?.code !== 'EADDRINUSE') throw error;
        studioHandle = await startStudioServer({ root: flowRoot(), port: 0 });
      }
      studioBase = baseFor(studioHandle.port);
      return await studioUp(studioBase);
    } catch (error) {
      console.error('[pet] Studio bootstrap failed:', error?.stack || error);
      studioBase = null;
      return false;
    } finally {
      studioStarting = null;
    }
  })();
  return studioStarting;
}

function latestFlow(flows) {
  if (!Array.isArray(flows) || flows.length === 0) return null;
  return [...flows].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
}

// Map the latest workflow to a cat reaction + hover-bubble text.
async function currentStatus() {
  const ok = await ensureStudio();
  if (!ok || !studioBase) return { online: false, flow: null };
  const port = studioHandle?.port ?? PREFERRED_PORT;
  const flows = await getJson(port, '/api/flows', 900);
  if (!Array.isArray(flows)) return { online: false, flow: null };
  return { online: true, flow: latestFlow(flows) };
}

function statusPayload(status) {
  const { online, flow } = status;
  if (!online) return { state: 'idle', text: 'AgentFlow · Studio 未连接', valid: null };
  if (!flow) return { state: 'idle', text: 'AgentFlow · 暂无工作流', valid: null };
  const total = Number(flow.total || 0), done = Number(flow.done || 0);
  const finished = total > 0 && done >= total;
  const name = flow.name || flow.id || 'AgentFlow';
  let state = 'idle', text;
  if (flow.valid === false) { state = 'error'; text = `${name} · 工作流结构异常`; }
  else if (finished) { state = 'done'; text = `${name} · ${done}/${total} 已完成`; }
  else { state = 'working'; text = `${name} · ${done}/${total} 进行中`; }
  return { state, text, valid: flow.valid };
}

let lastAgentState = null;
async function pollStatus() {
  const payload = statusPayload(await currentStatus());
  if (!win || win.isDestroyed()) return;
  if (payload.state !== lastAgentState) { lastAgentState = payload.state; win.webContents.send('agent', payload.state); }
}

// --- overlay window ----------------------------------------------------------
let win;
let tray;
let cfg = null;
let cursorTimer;
let topTimer;
let onBattery = false;
let lowPowerBroadcast = null;
let origin = { x: 0, y: 0 };
let hot = { x: 0, y: 0, w: 0, h: 0, dragging: false };
let ignoring = true;
let gestureActive = false;
let gestureDragged = false;
let gestureStart = null;
let suppressStudioUntil = 0;
let studioMouseIgnored = false;
let studioInteractionAllowedUntil = 0;

function effectiveLowPower() {
  return !!(cfg && (cfg.lowPower || (cfg.lowPowerOnBattery && onBattery)));
}
function broadcastPower() {
  const low = effectiveLowPower();
  if (low !== lowPowerBroadcast) {
    lowPowerBroadcast = low;
    if (win && !win.isDestroyed()) win.webContents.send('power', { lowPower: low });
    if (cursorTickRef) startCursorTimer(cursorTickRef);
  }
}
let cursorTickRef = null;
function startCursorTimer(tick) {
  cursorTickRef = tick;
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = setInterval(tick, effectiveLowPower() ? 50 : 8);
}

// Defence-in-depth: these windows only ever load local files, so deny any
// navigation or window-open attempt outright.
function hardenNav(w) {
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createWindow() {
  const b = screen.getPrimaryDisplay().bounds;
  origin = { x: b.x, y: b.y };

  const opts = {
    transparent: true, frame: false, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
  if (SHOT) {
    Object.assign(opts, { x: b.x + 80, y: b.y + 80, width: SHOT_CANVAS.w, height: SHOT_CANVAS.h + 40, focusable: true, show: true });
  } else {
    Object.assign(opts, { x: b.x, y: b.y, width: b.width, height: b.height, focusable: false, enableLargerThanScreen: true });
  }
  win = new BrowserWindow(opts);
  hardenNav(win);
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin' && !SHOT) {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) { /* ignore */ }
  }
  if (!SHOT) win.setIgnoreMouseEvents(true, { forward: true });

  const params = [];
  if (stateArg) params.push(`state=${stateArg}`);
  if (patternArg) params.push(`pattern=${patternArg}`);
  if (noteArg) params.push(`note=${encodeURIComponent(noteArg)}`);
  params.push(`size=${Math.max(SIZE_MIN, Math.min(SIZE_MAX, shotSize ?? (Number(cfg?.afSize) || 1)))}`);
  if (SHOT) params.push('shot=1');

  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[render-process-gone]', JSON.stringify(details));
    if (!SHOT && win && !win.isDestroyed() && details.reason !== 'clean-exit') {
      setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 400);
    }
  });
  win.webContents.on('console-message', (_e, _l, message) => console.log('[r]', message));
  win.webContents.on('did-finish-load', () => { applyConfigToOverlay(); sendGeom(); });
  win.loadFile(path.join(__dirname, 'index.html'), { search: params.join('&') });

  if (SHOT) {
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(shotOutput), { recursive: true });
        fs.writeFileSync(shotOutput, img.toPNG());
        console.log(`[captured ${shotOutput}]`);
        app.quit();
      }, shotAtMs);
    });
    return;
  }

  // Cursor loop: feed the local cursor to the renderer AND drive the click-through
  // toggle from main so a renderer stall can never leave the screen capturing clicks.
  let lastCurX = null, lastCurY = null;
  const cursorTick = () => {
    if (!win || win.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    const lx = pt.x - origin.x, ly = pt.y - origin.y;
    if (lx !== lastCurX || ly !== lastCurY) {
      lastCurX = lx; lastCurY = ly;
    }
    if (gestureActive && gestureStart && Math.hypot(pt.x - gestureStart.x, pt.y - gestureStart.y) > 6) {
      gestureDragged = true;
    }
    if (!gestureActive && gestureDragged && Date.now() >= suppressStudioUntil) {
      gestureDragged = false;
    }
    const over = hot.dragging ||
      (lx >= hot.x && lx <= hot.x + hot.w && ly >= hot.y && ly <= hot.y + hot.h);
    const wantIgnore = gestureActive ? false : !over;
    if (wantIgnore !== ignoring) {
      ignoring = wantIgnore;
      win.setIgnoreMouseEvents(wantIgnore, { forward: true });
    }
    const studioShouldIgnore = (over || gestureActive || gestureDragged || Date.now() < suppressStudioUntil) && Date.now() >= studioInteractionAllowedUntil;
    if (studioWindow && !studioWindow.isDestroyed() && studioShouldIgnore !== studioMouseIgnored) {
      studioMouseIgnored = studioShouldIgnore;
      studioWindow.setIgnoreMouseEvents(studioShouldIgnore, { forward: true });
    }
  };
  startCursorTimer(cursorTick);

  const refit = () => {
    if (!win || win.isDestroyed()) return;
    const d = screen.getPrimaryDisplay().bounds;
    origin = { x: d.x, y: d.y };
    win.setBounds({ x: d.x, y: d.y, width: d.width, height: d.height });
    sendGeom();
  };
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);

  // Keep the cat above EVERYTHING: re-assert on a timer (and reclaim with moveTop).
  const reassertTop = () => {
    if (!win || win.isDestroyed()) return;
    if (cfg && cfg.onTop === false) return;
    try {
      win.setAlwaysOnTop(false);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.moveTop();
    } catch (e) { /* ignore */ }
  };
  reassertTop();
  topTimer = setInterval(reassertTop, 700);
  win.webContents.on('did-finish-load', reassertTop);
  screen.on('display-metrics-changed', reassertTop);
  screen.on('display-added', reassertTop);
}

// ---- config: load, broadcast, persist ----------------------------------------
function applyConfigToOverlay() {
  if (win && !win.isDestroyed() && win.webContents) {
    try { win.setAlwaysOnTop(!cfg || cfg.onTop !== false, 'screen-saver'); } catch (e) { /* ignore */ }
    win.webContents.send('config', cfg);
    broadcastPower();
  }
}
function sendGeom() {
  if (!win || win.isDestroyed() || !win.webContents) return;
  const d = screen.getPrimaryDisplay(), b = d.bounds, wa = d.workArea;
  const bottomInset = Math.max(0, (b.y + b.height) - (wa.y + wa.height));
  const topInset = Math.max(0, wa.y - b.y), leftInset = Math.max(0, wa.x - b.x), rightInset = Math.max(0, (b.x + b.width) - (wa.x + wa.width));
  const bottomWorkY = (wa.y + wa.height) - b.y;
  win.webContents.send('geom', { bottomInset, topInset, leftInset, rightInset, bottomWorkY });
}
function persistAndBroadcast(next) {
  cfg = config.save(next);
  applyConfigToOverlay();
  rebuildTrayMenu();
}

// ---- tray and native menu localization ----------------------------------------
const MENU_COPY = {
  zh: {
    tooltip: 'AgentFlow 小宠', open: '打开 AgentFlow', size: '大小', sizeSet: '调整大小…', coat: '毛色', mood: '心情反应', floor: '只在地面', play: '游玩区域', whole: '整个屏幕', bottom: '底部区域', top: '顶部区域', leftThird: '左侧三分之一', rightThird: '右侧三分之一', always: '始终置顶', sound: '声音（喵）', low: '节能模式', battery: '电池供电时自动节能', current: (low, battery) => `当前：${low ? '节能' : '正常'}${battery ? '（电池）' : ''}`, language: '语言', system: '跟随系统', chinese: '中文', english: 'English', quit: '退出', coats: { 'Orange Tabby': '橘色虎斑', 'Mackerel Tabby': '鲭鱼纹虎斑', 'Brown Tabby': '棕色虎斑', Siamese: '暹罗', Tuxedo: '黑白猫', Black: '黑猫', Gray: '灰猫', White: '白猫', Cream: '奶油色', Tortoiseshell: '玳瑁', Calico: '三花猫', Slate: '石板灰', Chocolate: '巧克力色', 'Russian Blue': '俄罗斯蓝' }
  },
  en: {
    tooltip: 'AgentFlow Pet', open: 'Open AgentFlow', size: 'Size', sizeSet: 'Adjust size…', coat: 'Coat', mood: 'Mood reactions', floor: 'Stay on the floor', play: 'Play area', whole: 'Whole screen', bottom: 'Bottom strip', top: 'Top strip', leftThird: 'Left third', rightThird: 'Right third', always: 'Always on top', sound: 'Sound (meow)', low: 'Low-power mode', battery: 'Auto low-power on battery', current: (low, battery) => `Current: ${low ? 'low power' : 'normal'}${battery ? ' (battery)' : ''}`, language: 'Language', system: 'Follow system', chinese: '中文', english: 'English', quit: 'Quit', coats: {}
  }
};
function resolvedMenuLanguage() {
  const selected = cfg?.language;
  if (selected === 'zh' || selected === 'en') return selected;
  try { return String(app.getPreferredSystemLanguages?.()[0] || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'; }
  catch (_) { return 'en'; }
}
function menuText() { return MENU_COPY[resolvedMenuLanguage()]; }
function languageItems() {
  const t = menuText();
  return [
    { label: t.system, type: 'radio', checked: !cfg?.language || cfg.language === 'system', click: () => persistAndBroadcast({ ...cfg, language: 'system' }) },
    { label: t.chinese, type: 'radio', checked: cfg?.language === 'zh', click: () => persistAndBroadcast({ ...cfg, language: 'zh' }) },
    { label: t.english, type: 'radio', checked: cfg?.language === 'en', click: () => persistAndBroadcast({ ...cfg, language: 'en' }) },
  ];
}
function trayImage() {
  const p = path.join(__dirname, '..', 'assets', 'tray.png');
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return nativeImage.createEmpty();
  return img;
}
function createTray() {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip(menuText().tooltip);
    rebuildTrayMenu();
  } catch (e) { console.log('[tray-error]', e.message); }
}

function sizeItems() {
  const t = menuText();
  return [{ label: t.sizeSet, click: openSizeWindow }];
}
function openSizeWindow() {
  if (!win || win.isDestroyed()) return;
  if (sizeWindow && !sizeWindow.isDestroyed()) { sizeWindow.focus(); return; }
  sizeWindow = new BrowserWindow({
    width: 320, height: 150, resizable: false, alwaysOnTop: true,
    title: `${menuText().tooltip} ${menuText().size}`, parent: win, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'size-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  sizeWindow.loadFile(path.join(__dirname, 'size.html'), { search: `lang=${resolvedMenuLanguage()}` });
  sizeWindow.once('ready-to-show', () => sizeWindow?.show());
  sizeWindow.on('closed', () => { sizeWindow = null; });
}
function coatItems() {
  const t = menuText();
  return PATTERN_NAMES.map((name, i) => ({
    label: t.coats[name] || name, type: 'radio', checked: (cfg ? cfg.pattern : 0) === i,
    click: () => persistAndBroadcast({ ...cfg, pattern: i }),
  }));
}
function rebuildTrayMenu() {
  if (!tray) return;
  const t = menuText();
  tray.setToolTip(t.tooltip);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t.open, click: () => void openStudio() },
    { type: 'separator' },
    { label: t.size, submenu: sizeItems() },
    { label: t.coat, submenu: coatItems() },
    { label: t.mood, type: 'checkbox', checked: !(cfg && cfg.moodOn === false), click: () => persistAndBroadcast({ ...cfg, moodOn: !(cfg && cfg.moodOn !== false) }) },
    { label: t.floor, type: 'checkbox', checked: !(cfg && cfg.floorLock === false), click: () => persistAndBroadcast({ ...cfg, floorLock: !(cfg && cfg.floorLock !== false) }) },
    { label: t.play, submenu: [
      { label: t.whole, type: 'radio', checked: !(cfg && cfg.playArea), click: () => persistAndBroadcast({ ...cfg, playArea: null }) },
      { label: t.bottom, click: () => persistAndBroadcast({ ...cfg, playArea: { x: 0, y: 0.78, w: 1, h: 0.22 } }) },
      { label: t.top, click: () => persistAndBroadcast({ ...cfg, playArea: { x: 0, y: 0, w: 1, h: 0.25 } }) },
      { label: t.leftThird, click: () => persistAndBroadcast({ ...cfg, playArea: { x: 0, y: 0, w: 0.34, h: 1 } }) },
      { label: t.rightThird, click: () => persistAndBroadcast({ ...cfg, playArea: { x: 0.66, y: 0, w: 0.34, h: 1 } }) },
    ] },
    { label: t.always, type: 'checkbox', checked: !(cfg && cfg.onTop === false), click: () => persistAndBroadcast({ ...cfg, onTop: !(cfg && cfg.onTop !== false) }) },
    { label: t.sound, type: 'checkbox', checked: !!(cfg && cfg.soundOn), click: () => persistAndBroadcast({ ...cfg, soundOn: !cfg.soundOn }) },
    { label: t.low, type: 'checkbox', checked: !!(cfg && cfg.lowPower), click: () => persistAndBroadcast({ ...cfg, lowPower: !(cfg && cfg.lowPower) }) },
    { label: t.battery, type: 'checkbox', checked: !(cfg && cfg.lowPowerOnBattery === false), click: () => persistAndBroadcast({ ...cfg, lowPowerOnBattery: !(cfg && cfg.lowPowerOnBattery !== false) }) },
    { label: t.current(effectiveLowPower(), onBattery), enabled: false },
    { label: t.language, submenu: languageItems() },
    { type: 'separator' },
    { label: t.quit, click: () => app.quit() },
  ]));
}

// Right-click on the pet: size / coat / actions, popped at the cursor.
function popupContextMenu() {
  const t = menuText();
  const menu = Menu.buildFromTemplate([
    { label: t.open, click: () => void openStudio() },
    { type: 'separator' },
    { label: `${t.size}: ${Number(cfg?.afSize || 1).toFixed(2)}x`, click: openSizeWindow },
    { label: t.coat, submenu: coatItems() },
    { label: t.low, type: 'checkbox', checked: !!(cfg && cfg.lowPower), click: () => persistAndBroadcast({ ...cfg, lowPower: !(cfg && cfg.lowPower) }) },
    { label: t.battery, type: 'checkbox', checked: !(cfg && cfg.lowPowerOnBattery === false), click: () => persistAndBroadcast({ ...cfg, lowPowerOnBattery: !(cfg && cfg.lowPowerOnBattery !== false) }) },
    { label: t.floor, type: 'checkbox', checked: !(cfg && cfg.floorLock === false), click: () => persistAndBroadcast({ ...cfg, floorLock: !(cfg && cfg.floorLock !== false) }) },
    { label: t.language, submenu: languageItems() },
    { type: 'separator' },
    { label: t.always, type: 'checkbox', checked: !(cfg && cfg.onTop === false), click: () => persistAndBroadcast({ ...cfg, onTop: !(cfg && cfg.onTop !== false) }) },
    { label: t.quit, click: () => app.quit() },
  ]);
  const pt = screen.getCursorScreenPoint();
  menu.popup({ window: win, x: Math.round(pt.x), y: Math.round(pt.y) });
}

async function openStudio() {
  const ok = await ensureStudio();
  if (!ok || !studioBase) return false;
  if (!studioWindow || studioWindow.isDestroyed()) {
    studioWindow = new BrowserWindow({
      width: 1040, height: 720, minWidth: 820, minHeight: 560, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    studioWindow.on('focus', () => {
      const blocked = gestureActive || gestureDragged || Date.now() < suppressStudioUntil;
      if (blocked && studioWindow && !studioWindow.isDestroyed()) setImmediate(() => studioWindow?.blur());
    });
    studioWindow.on('closed', () => { studioWindow = null; });
  }
  await studioWindow.loadURL(`${studioBase}/`);
  studioInteractionAllowedUntil = Date.now() + 1200;
  studioMouseIgnored = false;
  studioWindow.setIgnoreMouseEvents(false, { forward: true });
  studioWindow.show();
  studioWindow.focus();
  return true;
}

// ---- IPC (guarded: only our own file:// windows) -----------------------------
function isTrustedSender(e) {
  const wc = e && e.sender;
  if (!wc) return false;
  if (win && !win.isDestroyed() && wc === win.webContents) return true;
  if (sizeWindow && !sizeWindow.isDestroyed() && wc === sizeWindow.webContents) return true;
  if (studioWindow && !studioWindow.isDestroyed() && wc === studioWindow.webContents) return true;
  try { const u = e.senderFrame && e.senderFrame.url; return typeof u === 'string' && u.startsWith('file:'); }
  catch (_) { return false; }
}
const onSecure = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (isTrustedSender(e)) fn(e, ...a); });

onSecure('hot', (_e, o) => {
  if (!o || typeof o !== 'object') return;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  hot = { x: num(o.x), y: num(o.y), w: Math.max(0, num(o.w)), h: Math.max(0, num(o.h)), dragging: !!o.dragging };
  if (hot.dragging && ignoring && win && !win.isDestroyed()) {
    ignoring = false;
    win.setIgnoreMouseEvents(false, { forward: true });
  }
});
onSecure('pet-gesture', (_e, payload) => {
  const next = typeof payload === 'object' ? !!payload.active : !!payload;
  if (next) {
    const pt = screen.getCursorScreenPoint();
    gestureActive = true;
    gestureDragged = false;
    suppressStudioUntil = 0;
    gestureStart = { x: pt.x, y: pt.y };
    if (win && !win.isDestroyed()) {
      ignoring = false;
      win.setIgnoreMouseEvents(false, { forward: true });
    }
    if (studioWindow && !studioWindow.isDestroyed()) {
      studioMouseIgnored = true;
      studioWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    return;
  }
  if (typeof payload === 'object' && payload?.dragged) gestureDragged = true;
  if (gestureDragged) suppressStudioUntil = Date.now() + 700;
  gestureActive = false;
  gestureStart = null;
  if (win && !win.isDestroyed()) {
    ignoring = true;
    win.setIgnoreMouseEvents(true, { forward: true });
  }
});
onSecure('quit', () => app.quit());
onSecure('pet-open-studio', () => {
  if (gestureActive || gestureDragged || Date.now() < suppressStudioUntil) return;
  void openStudio();
});
onSecure('pet-context-menu', () => popupContextMenu());
onSecure('pet-size-initial', (event) => {
  event.returnValue = Number(cfg?.afSize) >= SIZE_MIN ? Math.min(SIZE_MAX, Number(cfg.afSize)) : 1;
});
onSecure('pet-size-set', (_e, raw) => {
  const next = Number(raw);
  if (!Number.isFinite(next) || next < SIZE_MIN || next > SIZE_MAX) return;
  persistAndBroadcast({ ...cfg, afSize: next });
});

// ---- teardown ----------------------------------------------------------------
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  if (cursorTimer) clearInterval(cursorTimer);
  if (topTimer) clearInterval(topTimer);
  if (statusTimer) clearInterval(statusTimer);
  if (tray) { try { tray.destroy(); } catch (e) { /* ignore */ } tray = null; }
}

app.whenReady().then(() => {
  if (isSecondary) return;
  cfg = config.load();
  if (shotSize != null) cfg = { ...cfg, afSize: shotSize };
  createWindow();
  if (SHOT) return;
  createTray();
  pollStatus();
  statusTimer = setInterval(pollStatus, POLL_MS);
  try { onBattery = powerMonitor.isOnBatteryPower(); } catch (e) { onBattery = false; }
  try {
    powerMonitor.on('on-battery', () => { onBattery = true; broadcastPower(); rebuildTrayMenu(); });
    powerMonitor.on('on-ac', () => { onBattery = false; broadcastPower(); rebuildTrayMenu(); });
  } catch (e) { /* powerMonitor unavailable */ }
});

app.on('window-all-closed', () => {
  if (win && !win.isDestroyed()) return;
  app.quit();
});
app.on('before-quit', cleanup);
app.on('quit', () => studioHandle?.stop());
app.on('second-instance', () => {
  if (!isSecondary && win && !win.isDestroyed()) win.showInactive();
});
