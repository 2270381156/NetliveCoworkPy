'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { detectPackagedLayout } = require('../lib/packaged-layout');

test('Electron 因主程序名为 electron.exe 报未打包时，resources/app.asar 仍识别为打包目录', () => {
  const seen = [];
  const result = detectPackagedLayout({
    isPackaged: false,
    resourcesPath: 'C:\\Program Files\\IPMaster-Cowork\\resources',
    existsSync: (candidate) => {
      seen.push(candidate);
      return candidate.endsWith('app.asar');
    },
  });

  assert.strictEqual(result, true);
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0], /app\.asar$/);
});

test('源码 Electron 没有 resources/app.asar 时保持开发目录', () => {
  assert.strictEqual(detectPackagedLayout({
    isPackaged: false,
    resourcesPath: 'D:\\Sources\\electron\\node_modules\\electron\\dist\\resources',
    existsSync: () => false,
  }), false);
});

test('Electron 原生报告已打包时直接使用打包目录', () => {
  assert.strictEqual(detectPackagedLayout({
    isPackaged: true,
    resourcesPath: '',
    existsSync: () => { throw new Error('不应访问文件系统'); },
  }), true);
});
