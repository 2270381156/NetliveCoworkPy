'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

function initWithFakeUpdater(options) {
  const autoUpdater = {
    forceDevUpdateConfig: false,
    updateConfigPath: 'unchanged',
    on() {},
    setFeedURL(value) { this.feed = value; },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron-updater') return { autoUpdater };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../updater')];
    const { initUpdater } = require('../updater');
    initUpdater({
      config: { feedUrl: 'https://updates.example.test', channel: 'latest' },
      isPackaged: true,
      onEvent() {},
      ...options,
    });
    return autoUpdater;
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../updater')];
  }
}

test('electron.exe 误报未打包时仍启用更新，并读取安装包内 app-update.yml', () => {
  const autoUpdater = initWithFakeUpdater({
    nativeIsPackaged: false,
    updateConfigPath: 'C:\\Program Files\\IPMaster-Cowork\\resources\\app-update.yml',
  });

  assert.strictEqual(autoUpdater.forceDevUpdateConfig, true);
  assert.strictEqual(
    autoUpdater.updateConfigPath,
    'C:\\Program Files\\IPMaster-Cowork\\resources\\app-update.yml',
  );
});

test('Electron 原生打包态正常时不启用开发更新兼容开关', () => {
  const autoUpdater = initWithFakeUpdater({
    nativeIsPackaged: true,
    updateConfigPath: 'C:\\app\\resources\\app-update.yml',
  });

  assert.strictEqual(autoUpdater.forceDevUpdateConfig, false);
  assert.strictEqual(autoUpdater.updateConfigPath, 'unchanged');
});
