/* style-report.js —— ②图示层的"体检"（纯函数，无 DOM）：报告编码表的视觉表达情况，
   产出 observe 输出的 style 字段。跟 geometry-report.js 同一个哲学——**测量不是规则**：
   不打分、不进 DRC findings，只把事实摆给 agent 看，判断留给它。

   为什么需要这个模块（2026-07-27，由真实 agent 画的第一张图暴露）：
   agent 画完一张 DRC 满分的图，所有设备却都是清一色的纯色方框、没有一个图标。排查下来
   机制每一层都是通的——图标选择技能在包里、能被 list() 召回、description 写得
   很准——**工具就在手边，agent 就是没调**。因为 SOUL.md 把图标写成"可选、不设不影响任何
   DRC"，而 observe 的输出里也没有任何地方提到图标。agent 完全理性：DRC 100 分已经拿到，
   挑图标是零收益动作。**它优化的是被度量的东西**，没有反馈信号的地方就是盲区。
   所以光改 SOUL.md 的文案不够，必须让"没有图标"在 observe 的返回值里看得见。

   浏览器：window.TopoStyleReport；node：module.exports。 */
(function (root) {
  "use strict";

  // 从 draw-core 拿"真正画得出来的 glyph"，不在这里自己维护一份——两处一旦漂移，
  // 这个报告就会重新变成假的全清（2026-07-27 的教训，见下面 rolesWithoutIcon 那段）。
  const TopoDraw = typeof module !== "undefined" && module.exports
    ? require("./draw-core.js")
    : root.TopoDrawCore;
  const RENDERED_GLYPHS = new Set((TopoDraw && TopoDraw.RENDERED_GLYPHS) || ["cloud", "ellipsis"]);

  // 图标目录：用来判断作者写的 icon key 是不是真的存在。只有 node 侧读得到 catalog.json；
  // 浏览器侧拿不到就退化为"不校验 key"（此时 KNOWN_ICONS 为 null）。
  let KNOWN_ICONS = null;
  if (typeof module !== "undefined" && module.exports) {
    try {
      const cat = require("./icons.js").loadCatalog();
      KNOWN_ICONS = new Set(Object.keys(cat.icons || cat));
    } catch (e) { KNOWN_ICONS = null; }
  }

  function buildStyleReport(model) {
    const enc = (model && model.encoding) || {};
    const roles = enc.deviceRoles || {};

    // 哪些角色真的在图里用到了——编码表里定义了但没有设备使用的角色不值得提醒
    const usedRoles = new Set((model.devices || []).map(d => d.role));

    // ---- 没有视觉标识的角色 ----
    // decorative（"…"省略标记之类）不代表真实网络实体，本来就不该有图标；
    // glyph 只有 draw-core 真认得的那几个（cloud/ellipsis）才算合法的替代表达。
    //
    // 最初这里写的是 `if (r.decorative || r.glyph || r.icon) continue`——**任何非空 glyph
    // 都当成"有视觉标识"**。用 sample-dual-core 一验就露馅了：那份模型每个角色都写了
    // glyph:"switch"/"fw"，而 draw-core 只处理 cloud 和 ellipsis，其余值落到"普通方框"
    // 分支被静默忽略，画出来 0 个图标、全是纯色方框，style 报告却说"缺图标 []"。
    // 这正是这个模块本身要防的东西：一个看起来覆盖了、实际给假全清的检查。
    const rolesWithoutIcon = [];
    const unrenderedGlyphs = [];
    const unknownIcons = [];
    for (const [role, r] of Object.entries(roles)) {
      if (!usedRoles.has(role)) continue;
      if (r.decorative) continue;
      // icon 写了但目录里没有这个 key：图标解析不出来，照旧画纯色方框。
      // 这跟 unrenderedGlyphs 是同一类错误——**只看写没写、不看写的值认不认识**。
      // 2026-07-28 修 glyph 时只补了 glyph 那一条，icon 这条漏了：写 icon:"不存在的key"
      // 时 rolesWithoutIcon 是空的，agent 以为配好了，实际画出来全是纯色框。
      const iconKnown = r.icon && (KNOWN_ICONS === null || KNOWN_ICONS.has(r.icon));
      if (iconKnown) continue;
      if (r.icon) unknownIcons.push({ role, icon: r.icon });
      else if (r.glyph && RENDERED_GLYPHS.has(r.glyph)) continue;
      else if (r.glyph) unrenderedGlyphs.push({ role, glyph: r.glyph });
      rolesWithoutIcon.push(role);
    }

    // ---- 撞色 ----
    // 调色板是有限的（见 topo.js PALETTE），角色数超过板子长度必然有角色共用一组颜色。
    // 这不是错误——图例里仍然有文字区分——但 agent 应该知道，必要时可以自己显式写 fill/stroke。
    const byColor = new Map();
    for (const [role, r] of Object.entries(roles)) {
      if (!usedRoles.has(role)) continue;
      const key = String(r.fill) + "|" + String(r.stroke);
      if (!byColor.has(key)) byColor.set(key, []);
      byColor.get(key).push(role);
    }
    const roleColorCollisions = [];
    for (const [key, group] of byColor) {
      if (group.length > 1) {
        roleColorCollisions.push({ fill: key.split("|")[0], stroke: key.split("|")[1], roles: group.slice() });
      }
    }

    return {
      roleCount: usedRoles.size,
      rolesWithoutIcon,
      unrenderedGlyphs,
      unknownIcons,
      roleColorCollisions,
    };
  }

  const API = { buildStyleReport };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.TopoStyleReport = API;
})(typeof window !== "undefined" ? window : this);
