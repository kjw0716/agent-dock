'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onRows: (cb) => ipcRenderer.on('rows', (_e, rows) => cb(rows)),
  size: (h) => ipcRenderer.send('size', h),
  ready: () => ipcRenderer.send('ready'),
  expand: (on) => ipcRenderer.send('expand', !!on),
  answer: (req) => ipcRenderer.invoke('answer', req),
  setPlugin: (on) => ipcRenderer.invoke('plugin:set', !!on),
  dismiss: (agent, id) => ipcRenderer.send('dismiss', { agent, id }),
  openChat: (agent, id) => ipcRenderer.invoke('open', { agent, id }),
  markRead: (id) => ipcRenderer.send('read', id),
  resize: (dir, on) => ipcRenderer.send('resize', dir, !!on),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
});
