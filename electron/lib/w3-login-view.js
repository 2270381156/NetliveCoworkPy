'use strict';

const { EventEmitter } = require('events');

// 在现有主窗口的 contentView 上覆盖一个 W3 WebContentsView。
// 它拥有独立 webContents（不继承主页面的 preload/导航策略），但复用同一 Session 与 UA。
function createW3LoginView({ WebContentsView, parentWindow, session }) {
  if (typeof WebContentsView !== 'function') throw new TypeError('WebContentsView 不可用');
  if (!parentWindow || parentWindow.isDestroyed()) throw new Error('主窗口不可用');

  const view = new WebContentsView({
    webPreferences: {
      session,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const events = new EventEmitter();
  let destroyed = false;

  const syncBounds = () => {
    if (destroyed || parentWindow.isDestroyed()) return;
    const { width, height } = parentWindow.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  const onParentClosed = () => events.emit('closed');

  try {
    view.webContents.setUserAgent(parentWindow.webContents.getUserAgent());
  } catch {}
  parentWindow.contentView.addChildView(view);
  syncBounds();
  parentWindow.on('resize', syncBounds);
  parentWindow.on('closed', onParentClosed);

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try { parentWindow.removeListener('resize', syncBounds); } catch {}
    try { parentWindow.removeListener('closed', onParentClosed); } catch {}
    try { parentWindow.contentView.removeChildView(view); } catch {}
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {}
    events.removeAllListeners();
  };

  return {
    webContents: view.webContents,
    loadURL: (...args) => view.webContents.loadURL(...args),
    isDestroyed: () => destroyed || view.webContents.isDestroyed(),
    destroy,
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  };
}

module.exports = { createW3LoginView };
