const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('petAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-key'),
  getWeather: (force = false) => ipcRenderer.invoke('weather:get', force),
  sendChat: (message) => ipcRenderer.invoke('chat:send', message),
  clearChat: () => ipcRenderer.invoke('chat:clear'),
  setChatLayout: (layout) => ipcRenderer.invoke('ui:set-chat-layout', layout),
  setIgnoreMouse: (ignore) => ipcRenderer.send('window:set-ignore-mouse', ignore),
  moveBy: (x, y) => ipcRenderer.send('window:move-by', { x, y }),
  openApiKeys: () => ipcRenderer.invoke('external:open-api-keys'),
  openConversationFolder: () => ipcRenderer.invoke('conversation:open-folder'),
  chooseConversationDirectory: () => ipcRenderer.invoke('conversation:choose-directory'),
  hide: () => ipcRenderer.send('app:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  onOpenChat: (callback) => on('open-chat', callback),
  onOpenSettings: (callback) => on('open-settings', callback),
  onOpenContextPreview: (callback) => on('open-context-preview', callback),
  onRequestWeather: (callback) => on('request-weather', callback),
});
