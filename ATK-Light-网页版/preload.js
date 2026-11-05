// preload：向渲染进程暴露托盘宿主能力（打开链接 / 收起面板 / 退出 / 开机自启动）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__ATK_TRAY__', {
  /* 打开外部链接。
     ⚠ 必须走 IPC：preload 在 sandbox 里运行，`require('electron').shell` 是 undefined，
     直接在 preload 里调 shell.openExternal 会抛 "Cannot read properties of undefined"。
     这就是「打开 ATK HUB 点了没反应」的真正原因。 */
  openExternal: (url) => ipcRenderer.invoke('open-external', String(url)),

  // 收起面板（不是退出进程）
  hide: () => { ipcRenderer.send('panel-hide'); },

  // 真正退出应用：交给主进程 app.quit()，先标记 isQuitting 避免被 hide-on-close 拦住
  quit: () => { ipcRenderer.send('app-quit'); },

  // 开机自启动：读/写都由主进程处理，渲染层只拿结果
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  setAutoStart: (on) => ipcRenderer.invoke('autostart:set', !!on),
});
