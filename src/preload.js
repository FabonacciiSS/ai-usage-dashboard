const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("usageBridge", {
  getUsageSnapshot: () => ipcRenderer.invoke("openai:getUsageSnapshot"),
  getCodexUsageSnapshot: (payload) => ipcRenderer.invoke("codex:getUsageSnapshot", payload),
  getCar360UsageSnapshot: (payload) => ipcRenderer.invoke("car360:getUsageSnapshot", payload),
  getDeepSeekBalance: () => ipcRenderer.invoke("deepseek:getBalance"),
  getZenBalance: () => ipcRenderer.invoke("zen:getBalance"),
  getOpenCodeGoUsage: (payload) => ipcRenderer.invoke("opencode-go:getUsage", payload),
  reconnectOpenCodeGo: (payload) => ipcRenderer.invoke("opencode-go:reconnect", payload),
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setTheme: (mode) => ipcRenderer.invoke("theme:set", mode),
  onThemeChanged: (callback) => ipcRenderer.on("theme:changed", (_event, dark) => callback(dark))
});
