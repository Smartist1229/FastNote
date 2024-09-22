// src/electron.d.ts
declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        send: (channel: string, ...args: any[]) => void;
        on: (channel: string, callback: (...args: any[]) => void) => void;
        once: (channel: string, callback: (...args: any[]) => void) => void;
        removeListener: (channel: string, callback: (...args: any[]) => void) => void;
      };
      saveFile: (title: string, content: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    };
  }
}

export {}; // 确保这个文件被当作一个模块处理
