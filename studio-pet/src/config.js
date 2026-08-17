// Settings store (main process). Owns settings.json in the per-user app data dir
// and is the single source of truth for name / coat / size / behavior flags.
// Reads are tolerant (missing or corrupt file -> DEFAULTS); writes are atomic
// (tmp + rename) so a crash mid-write can't leave a half-written file.
//
// Trimmed from pixelpets' config.js: pomodoro / lobby-jam / reminders / email /
// calendar / dog-species were stripped. Keys the renderer still reads are kept.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const { PATTERN_NAMES } = require('./patterns');

const MAX_PATTERN = PATTERN_NAMES.length - 1;
// Out-of-box coat: the black-and-white tuxedo cat (黑白猫).
const DEFAULT_PATTERN = Math.max(0, PATTERN_NAMES.indexOf('Tuxedo'));

const DEFAULTS = {
  name: '',
  pattern: DEFAULT_PATTERN,
  afSize: 1,           // pet scale: any value from 0.2 to 3.0 (right-click slider)
  soundOn: false,      // synthesized meows are off by default (desktop pet politeness)
  huntOn: false,       // do not chase the mouse by default
  followCursor: false, // do not follow or track the mouse by default
  moodOn: true,        // energy/mood model (calm/playful/zoomies + startle)
  startleOn: false,    // do not bolt when the cursor moves
  playArea: null,      // { x,y,w,h } fractions of the screen the cat stays in; null = whole screen
  onTop: true,         // keep the cat above all other windows
  roamOn: false,       // keep the cat stationary unless dragged
  restSide: 'right',   // which bottom corner is home: 'left' | 'right'
  floorLock: false,    // free movement inside the play area by default
  butterflyOn: false,  // disable autonomous visitors by default
  workMode: false,     // park in the rest corner + hide roaming/hunt/butterfly while working
  volume: 100,         // master sound volume 0-100
  reducedMotion: false,// calm mode: no roaming/bouncing/screen-glow
  lowPower: false,     // fewer idle frames + slower cursor polling to spare CPU/GPU
  lowPowerOnBattery: true, // auto-enter low power while running on battery
  pinnedNote: '',      // fixed message pinned above the cat's head ('' = off)
  notifyOn: false,     // Windows toasts for messages (off by default on macOS)
  language: 'system',  // native menus: follow OS, or force 'zh'/'en'
};

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function normArea(a) {
  if (!a || typeof a !== "object") return null;
  const f = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(1, +v)) : null);
  const x = f(a.x), y = f(a.y), w = f(a.w), h = f(a.h);
  if (x == null || y == null || w == null || h == null || w < 0.05 || h < 0.05) return null;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

// Coerce arbitrary input into the strict schema. Unknown keys are dropped so a
// stale settings.json from a fuller build can't smuggle junk behavior back in.
function normalize(cfg) {
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  return {
    name: String(c.name == null ? '' : c.name).trim().slice(0, 24),
    pattern: clampInt(c.pattern, 0, MAX_PATTERN, DEFAULT_PATTERN),
    afSize: Math.max(0.2, Math.min(3, Number.isFinite(Number(c.afSize)) ? Number(c.afSize) : 1)),
    soundOn: c.soundOn === true,
    huntOn: false,
    followCursor: false,
    moodOn: c.moodOn !== false,
    startleOn: false,
    playArea: normArea(c.playArea),
    onTop: c.onTop !== false,
    roamOn: false,
    restSide: c.restSide === 'left' ? 'left' : 'right',
    floorLock: c.floorLock === true,
    butterflyOn: false,
    workMode: c.workMode === true,
    volume: clampInt(c.volume, 0, 100, 100),
    reducedMotion: c.reducedMotion === true,
    lowPower: c.lowPower === true,
    lowPowerOnBattery: c.lowPowerOnBattery !== false,
    pinnedNote: String(c.pinnedNote == null ? '' : c.pinnedNote).slice(0, 200),
    notifyOn: c.notifyOn === true,
    language: c.language === 'zh' || c.language === 'en' ? c.language : 'system',
  };
}

function load() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (e) { raw = {}; }                       // missing or corrupt -> defaults
  return normalize(raw);
}

function save(next) {
  const cfg = normalize({ ...load(), ...(next && typeof next === 'object' ? next : {}) });
  try {
    const p = filePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, p);                      // atomic: a crash can't corrupt settings.json
  } catch (e) { /* best-effort persist */ }
  return cfg;
}

module.exports = { DEFAULTS, DEFAULT_PATTERN, MAX_PATTERN, load, save, normalize };
