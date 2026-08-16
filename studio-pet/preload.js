"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("petAPI", {
  expand: () => ipcRenderer.invoke("pet-expand"),
  collapse: () => ipcRenderer.send("pet-collapse")
});
