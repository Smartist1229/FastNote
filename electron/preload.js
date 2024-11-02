const { contextBridge, ipcRenderer, shell } = require('electron');
const fs = require('fs');

contextBridge.exposeInMainWorld('electron', {
  openExternal: (url) => shell.openExternal(url),
  ipcRenderer: {
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(event, ...args)),
    once: (channel, func) => ipcRenderer.once(channel, (event, ...args) => func(event, ...args)),
    removeListener: (channel, func) => ipcRenderer.removeListener(channel, func),
  },
  saveFile: async (title, content) => {
    try {
      const result = await ipcRenderer.invoke('dialog:saveFile', title);
      if (result.canceled) {
        return { success: false, error: '用户取消了保存操作' };
      }
      if (result.filePath) {
        fs.writeFileSync(result.filePath, content, 'utf-8');
        return { success: true, filePath: result.filePath };
      } else {
        return { success: false, error: '没有指定文件路径' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
  
});


