'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

let createW3LoginView;
try {
  ({ createW3LoginView } = require('../lib/w3-login-view'));
} catch { /* RED: module does not exist before the implementation */ }

test('W3 视图挂载在当前主窗口并复用 Session 与 User-Agent', async () => {
  assert.strictEqual(typeof createW3LoginView, 'function');

  const sharedSession = { id: 'shared-session' };
  const added = [];
  const removed = [];
  let contentBounds = { x: 10, y: 20, width: 1280, height: 800 };
  class FakeParentWindow extends EventEmitter {
    constructor() {
      super();
      this.contentView = {
        addChildView: (view) => added.push(view),
        removeChildView: (view) => removed.push(view),
      };
      this.webContents = { getUserAgent: () => 'shared-user-agent' };
    }
    getContentBounds() { return contentBounds; }
    isDestroyed() { return false; }
  }
  class FakeWebContentsView {
    constructor(options) {
      this.options = options;
      this.bounds = [];
      this.closed = false;
      this.loadedUrls = [];
      this.webContents = {
        setUserAgent: (value) => { this.userAgent = value; },
        loadURL: async (url) => { this.loadedUrls.push(url); },
        isDestroyed: () => this.closed,
        close: () => { this.closed = true; },
      };
    }
    setBounds(bounds) { this.bounds.push(bounds); }
  }

  const parentWindow = new FakeParentWindow();
  const surface = createW3LoginView({
    WebContentsView: FakeWebContentsView,
    parentWindow,
    session: sharedSession,
  });
  const view = added[0];

  assert.ok(view instanceof FakeWebContentsView);
  assert.strictEqual(view.options.webPreferences.session, sharedSession);
  assert.strictEqual(view.userAgent, 'shared-user-agent');
  assert.deepStrictEqual(view.bounds[0], { x: 0, y: 0, width: 1280, height: 800 });

  contentBounds = { x: 0, y: 0, width: 1440, height: 900 };
  parentWindow.emit('resize');
  assert.deepStrictEqual(view.bounds.at(-1), { x: 0, y: 0, width: 1440, height: 900 });

  await surface.loadURL('https://login.example/');
  assert.deepStrictEqual(view.loadedUrls, ['https://login.example/']);

  surface.destroy();
  assert.deepStrictEqual(removed, [view]);
  assert.strictEqual(view.closed, true);
  assert.strictEqual(parentWindow.listenerCount('resize'), 0);
});

test('关闭主窗口会通知 W3 认证流程取消登录', () => {
  assert.strictEqual(typeof createW3LoginView, 'function');

  class FakeParentWindow extends EventEmitter {
    constructor() {
      super();
      this.contentView = { addChildView: () => {}, removeChildView: () => {} };
      this.webContents = { getUserAgent: () => 'ua' };
    }
    getContentBounds() { return { width: 1000, height: 700 }; }
    isDestroyed() { return false; }
  }
  class FakeWebContentsView {
    constructor() {
      this.webContents = {
        setUserAgent: () => {},
        loadURL: async () => {},
        isDestroyed: () => false,
        close: () => {},
      };
    }
    setBounds() {}
  }

  const parentWindow = new FakeParentWindow();
  const surface = createW3LoginView({
    WebContentsView: FakeWebContentsView,
    parentWindow,
    session: {},
  });
  let closed = false;
  surface.on('closed', () => { closed = true; });

  parentWindow.emit('closed');

  assert.strictEqual(closed, true);
});
