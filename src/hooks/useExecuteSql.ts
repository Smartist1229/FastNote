const { ipcRenderer } = window.electron;

function executeSql(eventName: string, sql: string, type: string, responseEvent: string, params: (string)[] = []) {
  ipcRenderer.send(eventName, {
    sql,
    type,
    responseEvent,
    params,
  });
}

function getResponse(responseEvent: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (event:Event, response: any) => {
      ipcRenderer.removeListener(responseEvent, handler);
      if (response.success) {
        resolve(response);
      } else {
        reject(response.error);
      }
    };
    ipcRenderer.on(responseEvent, handler);
  });
}

export { executeSql, getResponse }
