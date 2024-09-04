const { ipcRenderer } = window.electron;

function refresh() {
    ipcRenderer.send("refresh");
}

export { refresh }