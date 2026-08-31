'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadingHtml, SPLASH_TITLEBAR_HEIGHT, SPLASH_CONTROLS_WIDTH } = require('../lib/splash');

function html(opts) {
  const url = loadingHtml(opts);
  assert.ok(url.startsWith('data:text/html;charset=utf-8,'), 'must be a data: URL');
  return decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length));
}

function bodyTag(h) {
  const m = h.match(/<body[^>]*>/);
  assert.ok(m, 'body tag must exist');
  return m[0];
}

// 回归护栏（PR #127）：splash 曾整页 -webkit-app-region:drag。Electron 的可拖拽
// 区域是窗口级状态，导航到一个不声明任何 app-region 的页面（LoginGate）时旧区域
// 不会被清空，于是整页 drag 盖住登录页——按钮点不动、只能拖窗口。
test('splash 的 body 不得整页可拖', () => {
  const tag = bodyTag(html({ productName: 'X', zh: true }));
  assert.ok(
    !/-webkit-app-region\s*:\s*drag/.test(tag),
    `body 不能声明 drag，否则整页可拖会残留到下一个页面；实际: ${tag}`,
  );
});

test('splash 只在顶栏声明拖拽区，尺寸与真实 UI 顶栏一致', () => {
  const h = html({ productName: 'X', zh: true });
  const dragEls = (h.match(/<div[^>]*-webkit-app-region\s*:\s*drag[^>]*>/g) || []);
  assert.equal(dragEls.length, 1, `应恰有一个拖拽条，实际 ${dragEls.length} 个`);
  const el = dragEls[0];
  assert.ok(new RegExp(`height\s*:\s*${SPLASH_TITLEBAR_HEIGHT}px`).test(el), `拖拽条高度应为 ${SPLASH_TITLEBAR_HEIGHT}px：${el}`);
  assert.ok(/top\s*:\s*0/.test(el), `拖拽条应贴顶：${el}`);
  assert.ok(
    new RegExp(`right\s*:\s*${SPLASH_CONTROLS_WIDTH}px`).test(el),
    `拖拽条右侧应让出 ${SPLASH_CONTROLS_WIDTH}px 给窗口控件：${el}`,
  );
});

test('产品名与语言正确注入', () => {
  assert.ok(html({ productName: 'IPMaster-Cowork', zh: true }).includes('正在启动 IPMaster-Cowork…'));
  assert.ok(html({ productName: 'IPMaster-Cowork', zh: false }).includes('Starting IPMaster-Cowork…'));
});
