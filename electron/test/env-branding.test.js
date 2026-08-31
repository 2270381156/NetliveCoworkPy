'use strict';

// 出厂 .env 的品牌覆盖：**「品牌没写这个键」与「品牌写成空」必须是两种结果**。
//
// 这条测试是为一个真实事故写的：一次「配置来源改成 branding」的提交用了
// `branding.skillMarketUrl || ''`，在没有该键的产品线上把模板里的真实技能市场地址抹成空，
// 新装机器的技能页整个打不开。旧写法能通过下面第 2、3 条，只会挂在第 1 条上。

const test = require('node:test');
const assert = require('node:assert');

const { applyBrandingEnv, brandingEnvLines, BRANDED_ENV_KEYS } = require('../lib/env-branding');

// **出厂模板是 CRLF，样例必须也是 CRLF**：LF 样例会放过「`\s*` 吃掉换行、把赋值粘到上一行
// 注释尾巴上」那个坑（`\r` 在 JS 正则里也是行终止符，`^` 在 `\r` 与 `\n` 之间成立）。
// 上一行特意放一条注释，就是为了让那种粘连能被看见。
const LINES = [
  'NLC_DATA_DIR=./data',
  'NLC_SKILL_PULL_SERVER_URL=https://cowork.example.com/api',
  '# IP Master Mythos 服务地址（厂商内置）。',
  'NLC_SKILL_MYTHOS_BASE_URL=https://mythos.example.com',
  'NLC_LOG_FILENAME=backend.log',
];
const TEMPLATE = LINES.join('\r\n');

// 按 .env 的读法取值：以 # 开头的行是注释，不算数。粘到注释里的赋值必须取不到。
const mythosLine = (text) => text
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith('#'))
  .find((l) => l.startsWith('NLC_SKILL_MYTHOS_BASE_URL='));

test('品牌没写这个键 → 模板原值原样保留（事故那条）', () => {
  const branding = { productName: 'IPMaster-Cowork' };   // 没有 skillMarketUrl
  assert.strictEqual(
    mythosLine(applyBrandingEnv(TEMPLATE, branding)),
    'NLC_SKILL_MYTHOS_BASE_URL=https://mythos.example.com',
  );
});

test('品牌显式写成空串 → 就是要空（该品牌没有这个市场）', () => {
  const out = applyBrandingEnv(TEMPLATE, { skillMarketUrl: '' });
  assert.strictEqual(mythosLine(out), 'NLC_SKILL_MYTHOS_BASE_URL=');
});

test('品牌给了地址 → 覆盖模板', () => {
  const out = applyBrandingEnv(TEMPLATE, { skillMarketUrl: 'https://brand.example.com' });
  assert.strictEqual(mythosLine(out), 'NLC_SKILL_MYTHOS_BASE_URL=https://brand.example.com');
});

test('模板里该行被注释掉时也能被品牌值激活', () => {
  const commented = TEMPLATE.replace(
    'NLC_SKILL_MYTHOS_BASE_URL=https://mythos.example.com',
    '#NLC_SKILL_MYTHOS_BASE_URL=',
  );
  const out = applyBrandingEnv(commented, { skillMarketUrl: 'https://brand.example.com' });
  assert.strictEqual(mythosLine(out), 'NLC_SKILL_MYTHOS_BASE_URL=https://brand.example.com');
});

test('CRLF 模板：赋值必须自成一行，不许粘到上一行注释尾巴上', () => {
  const out = applyBrandingEnv(TEMPLATE, { skillMarketUrl: 'https://brand.example.com' });
  // 行数不变 = 没有吃掉换行
  assert.strictEqual(out.split(/\r?\n/).length, LINES.length);
  // 上一行仍是纯注释，尾巴上没被粘东西
  assert.strictEqual(out.split(/\r?\n/)[2], '# IP Master Mythos 服务地址（厂商内置）。');
  // 且这一行确实生效（不是躲在注释里）
  assert.strictEqual(mythosLine(out), 'NLC_SKILL_MYTHOS_BASE_URL=https://brand.example.com');
});

test('CRLF 的行尾 \\r 原样保留，不产生 \\n 裸行', () => {
  const out = applyBrandingEnv(TEMPLATE, { skillMarketUrl: 'https://brand.example.com' });
  assert.ok(out.includes('NLC_SKILL_MYTHOS_BASE_URL=https://brand.example.com\r\n'));
  assert.ok(!/[^\r]\n/.test(out), '出现了 LF 裸行 —— 行尾被破坏了');
});

test('branding 为 null/undefined 时不改动模板', () => {
  assert.strictEqual(applyBrandingEnv(TEMPLATE, null), TEMPLATE);
  assert.strictEqual(applyBrandingEnv(TEMPLATE, undefined), TEMPLATE);
});

test('只动自己那几行，别的 env 项一个不碰', () => {
  const out = applyBrandingEnv(TEMPLATE, { skillMarketUrl: 'https://brand.example.com' });
  assert.ok(out.includes('NLC_SKILL_PULL_SERVER_URL=https://cowork.example.com/api'));
  assert.ok(out.includes('NLC_DATA_DIR=./data'));
  assert.strictEqual(out.split('\n').length, TEMPLATE.split('\n').length);
});

// ── 无模板兜底路径（打包态理论上不会走到，但它同样不能凭空写出空值）──────────────

test('无模板时：品牌没写 → 不产出这一行（凭空写空值 = 明确禁用，不是同一件事）', () => {
  assert.deepStrictEqual(brandingEnvLines({ productName: 'X' }), []);
  assert.deepStrictEqual(brandingEnvLines(null), []);
});

test('无模板时：品牌写了 → 产出该行', () => {
  assert.deepStrictEqual(
    brandingEnvLines({ skillMarketUrl: 'https://brand.example.com' }),
    ['NLC_SKILL_MYTHOS_BASE_URL=https://brand.example.com'],
  );
});

test('两条路径覆盖同一组键，加新项时不会只加一半', () => {
  const branding = Object.fromEntries(BRANDED_ENV_KEYS.map((k) => [k.brandingKey, 'https://v']));
  const fromTemplate = BRANDED_ENV_KEYS.map((k) => `${k.envKey}=https://v`);
  assert.deepStrictEqual(brandingEnvLines(branding), fromTemplate);
});
