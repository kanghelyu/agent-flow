const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petSize', {
  initial: () => ipcRenderer.sendSync('pet-size-initial'),
  set: (value) => ipcRenderer.send('pet-size-set', Number(value)),
});
