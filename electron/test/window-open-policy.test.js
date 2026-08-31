'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { safeUrlForLog } = require('../lib/window-open-policy');

test('W3 诊断日志移除 URL 查询参数和片段', () => {
  assert.strictEqual(
    safeUrlForLog('https://login.huawei.com/oauth/callback?code=secret&state=secret#token'),
    'https://login.huawei.com/oauth/callback',
  );
  assert.strictEqual(
    safeUrlForLog('https://localhost:18080/getSpesInfo?key=secret'),
    'https://localhost:18080/getSpesInfo',
  );
});

test('W3 诊断日志不会展开 data URL 或非法 URL', () => {
  assert.strictEqual(safeUrlForLog('data:text/html,secret'), 'data:');
  assert.strictEqual(safeUrlForLog('not a url'), '<invalid-url>');
});
