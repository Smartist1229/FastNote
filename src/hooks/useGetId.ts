const { ipcRenderer } = window.electron;

// 设置传递的id
export const getId = (id:string, responseEvent:string) => {
    ipcRenderer.send("get-id", {
      id: id,
      responseEvent: responseEvent,
    });
  };

