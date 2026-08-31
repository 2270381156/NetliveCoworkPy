'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  reportSession: (sessionId, note) => ipcRenderer.invoke('report-session', sessionId, note),
  // Convert EMF/WMF metafiles to PNG via the OS (GDI+). items = [{key,b64}].
  convertEmf: (items) => ipcRenderer.invoke('convert-emf', items),
  // 桌面端浏览器登录（OAuth）。login 打开浏览器走授权流程，成功后 resolve user；
  // getSession 启动时取已登录用户（含云端吊销检查）；logout 清除本地凭证。
  login: () => ipcRenderer.invoke('auth-login'),
  // 认证期间渲染层意外重载时，拉取主进程暂存的 W3 登录错误（正常流程不使用）。
  getLoginError: () => ipcRenderer.invoke('auth-login-error'),
  logout: () => ipcRenderer.invoke('auth-logout'),
  getSession: () => ipcRenderer.invoke('auth-session'),
  // 取当前 access token（用于上传 skill 时以用户身份转发给 cowork 写 creator）。
  getToken: () => ipcRenderer.invoke('auth-token'),
  // Renderer→main "I mounted successfully" ping. Main starts a watchdog after
  // loading the UI; if this never arrives, the page loaded but the app didn't
  // render (blocked module, JS throw on mount, …) → main surfaces an error
  // instead of a silent white screen.
  signalReady: () => ipcRenderer.send('renderer-ready'),
  // 桌面通知：系统 toast + 任务栏闪烁。force=true 绕过「窗口聚焦时不打扰」
  // （启动盘点专用——窗口刚打开必然是聚焦的）。
  notify: (payload) => ipcRenderer.invoke('notify', payload),
  // 待处理数量 → 托盘悬停提示；0 时顺带停掉托盘闪动。
  setPending: (payload) => ipcRenderer.invoke('set-pending', payload),
  // 用户点了 toast → 主进程已激活窗口，这里通知渲染层跳到对应会话。
  onNotificationClick: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('notification-click', handler);
    return () => ipcRenderer.removeListener('notification-click', handler);
  },
  onUpdateStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
});
