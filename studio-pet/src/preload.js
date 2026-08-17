const { contextBridge, ipcRenderer } = require('electron');

// Each onXxx() registration REPLACES any previous handler for that channel, so
// listeners never stack across overlay reloads (e.g. the GPU-crash auto-recovery
// in main.js calls win.reload(), which re-runs the renderer's registrations).
const sub = (channel, transform) => (cb) => {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, ...args) => cb(transform ? transform(...args) : undefined));
};

contextBridge.exposeInMainWorld('cat', {
  onCursor: sub('cursor', (d) => d),
  onAgent: sub('agent', (s) => s),
  onConfig: sub('config', (cfg) => cfg),
  onPower: sub('power', (p) => p),
  onNotify: sub('notify', (d) => d),
  onGeom: sub('geom', (g) => g),
  setHot: (o) => ipcRenderer.send('hot', o),
  gesture: (payload) => ipcRenderer.send('pet-gesture', typeof payload === 'object' ? payload : { active: !!payload }),
  contextMenu: () => ipcRenderer.send('pet-context-menu'),
  openStudio: () => ipcRenderer.send('pet-open-studio'),
  quit: () => ipcRenderer.send('quit'),
});
