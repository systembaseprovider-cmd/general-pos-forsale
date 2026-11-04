const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posDesktop', {
    getPrinters: () => ipcRenderer.invoke('pos:get-printers'),
    printReceipt: (html, deviceName) => ipcRenderer.invoke('pos:print-receipt', { html, deviceName })
});
