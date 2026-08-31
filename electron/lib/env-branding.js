'use strict';

// 出厂 .env 里「以 branding.json 为准」的那几行该怎么写。
//
// 规则只有一条，但它就是这个文件存在的理由：
//
//   **品牌文件里没有这个键 ≠ 品牌把它设成了空。**
//
//   * 没写这个键 → 这条产品线不管这事：保持出厂模板里的原值，别动它
//   * 写了（哪怕空串）→ 有意为之：按品牌来（空串 = 本品牌没有这个市场）
//
// 混淆这两者出过一次事故：一次「把配置来源改成 branding」的提交改了两处，MCP 定义那处
// 写了回落（branding 没有 mcpServers → 读随包 mcp.json），skill 市场地址那处没写，直接
// `branding.skillMarketUrl || ''`。而同一个提交并没有往 branding.json 里加这个键 —— 于是
// 在没有该键的产品线上，出厂模板里的真实地址被抹成空，新装的机器技能市场直接没了。
// 这里把「没写就别动」固化下来，让所有 branding 驱动的 env 项与 MCP 那处口径一致。

// branding.json 的键 → .env 的键。以后再有「以 branding 为准」的 env 项，加这一行即可，
// 不要再在 main.js 里手写一次 replace（手写的那次就是漏了回落）。
const BRANDED_ENV_KEYS = [
  { envKey: 'NLC_SKILL_MYTHOS_BASE_URL', brandingKey: 'skillMarketUrl' },
];

/** 品牌是否**显式**给出了这个值（null/undefined 都算没给）。 */
function isProvided(value) {
  return value !== undefined && value !== null;
}

/**
 * 匹配「模板里的那一行」。行内空白只用 `[ \t]`，**绝不能用 `\s`**。
 *
 * 出厂模板是 CRLF，而 JS 的 `\r` 也是行终止符：`^` 在 `\r` 与 `\n` 之间同样成立。
 * 用 `\s*` 的话，正则会从那个位置起手、把 `\n` 一起吃掉，替换结果就被粘到上一行注释的
 * 尾巴上（`# 说明…\rNLC_SKILL_MYTHOS_BASE_URL=值`）——整行以 `#` 开头，**这个配置项
 * 就此变成注释，给了值也不生效**。`.*` 不匹配行终止符，所以行尾的 `\r` 会原样留下。
 */
function lineMatcher(envKey) {
  return new RegExp(`^[ \\t]*#?[ \\t]*${envKey}=.*`, 'm');
}

/**
 * 在出厂模板文本上套用品牌值。品牌没写的键原样跳过 —— 模板里那一行保留。
 * 模板里该行可能是注释掉的（`#NLC_...=`），一并替换成生效行。
 */
function applyBrandingEnv(templateText, branding) {
  let out = templateText;
  for (const { envKey, brandingKey } of BRANDED_ENV_KEYS) {
    const value = branding ? branding[brandingKey] : undefined;
    if (!isProvided(value)) continue;
    out = out.replace(lineMatcher(envKey), `${envKey}=${value}`);
  }
  return out;
}

/**
 * 没有模板可套时（理论上打包态不会发生）要额外写出的行。
 * 同样只在品牌显式给了值时才产出：凭空写一行空值等于「明确禁用该市场」，
 * 与「这条产品线没管过这事」不是一回事。
 */
function brandingEnvLines(branding) {
  const lines = [];
  for (const { envKey, brandingKey } of BRANDED_ENV_KEYS) {
    const value = branding ? branding[brandingKey] : undefined;
    if (!isProvided(value)) continue;
    lines.push(`${envKey}=${value}`);
  }
  return lines;
}

module.exports = { applyBrandingEnv, brandingEnvLines, BRANDED_ENV_KEYS };
