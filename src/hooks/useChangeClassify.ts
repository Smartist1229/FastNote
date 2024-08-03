const { ipcRenderer } = window.electron;

// 设置传递的id
function getClassContent(className: string, classId: string, responseEvent: string) {
    ipcRenderer.send('classify-new', {
        className: className,
        classId: classId,
        responseEvent: responseEvent,
    });
};

function setClassContent(responseEvent: string): Promise<any> {
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

export { getClassContent, setClassContent };