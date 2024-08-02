const { ipcRenderer } = window.electron;

// 设置传递的id
function getId(id: string, responseEvent: string) {
  ipcRenderer.send("get-id", {
    id: id,
    responseEvent: responseEvent,
  });
};

function setId(responseEvent: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (event, response) => {
      ipcRenderer.removeListener(responseEvent, handler);
      if (response.success) {
        resolve(response);
      } else {
        reject(response.error);
      }
    };
    ipcRenderer.on(responseEvent, handler)
  });
}

export { getId, setId };