/* DRC（Drawing Rule Check）引擎：纯逻辑，读 model(语义) + layout(派生坐标)，吐结构化诊断 + 评分。
   这是 observer 轮要读的输入的雏形——Agent 不靠截图，靠这份报告推理。
   浏览器：window.TopoDRC；node：module.exports。

   有意收窄的范围：只查"这份图纸本身画得对不对，会不会真的破坏/污染渲染结果"——引用的编码
   有没有定义、id/label 有没有重复或缺失。**不**校验网络工程设计好不好（HA 冗余、上联条数、
   单点故障之类）——这里画的是抽象拓扑，同一种网络结构可以有很多种同样合法的画法
   （HA 对可以画成两个独立设备各自接上下游，也可以画成一个框代表一组、框本身接上下游，
   还可能是多设备重叠代表一个 pool），像"关键设备必须有 >1 条上联"这种规则默认了一种
   具体画法，换个画法它就文不对题；而真正的网络工程判断远比这类结构规则丰富得多，
   不适合在这里用简单规则表达。是否符合用户实际想要的网络设计，留给 agent 自己
   对照用户需求做语义判断，不是这份引擎的职责（另见项目 memory
   project_alignment_gap 里关于"语义层核查"的后续讨论）。

   同理，label 重复（两台设备显示同一个名字）和 legend 文案为空（编码表条目存在但不填
   图例说明）也**不**检查——这两者都不影响渲染正确性，是合法的风格选择：人类设计者可能
   就是想让一对设备显示同名，也可能就是不想在某条编码上显示图例文案。判断测试是"违反
   这条规则会不会让渲染结果本身出错/损坏/产生引用歧义"——label 只是显示文本，不参与任何
   引用解析，legend 文案为空也不影响任何东西被正确画出来，所以都不算图纸缺陷。 */
(function (root) {
  "use strict";

  const TopoCore = typeof module !== "undefined" && module.exports
    ? require("./topo.js")
    : root.TopoCore;

  function runDRC(model, layout) {
    const findings = [];
    const add = (rule, severity, message, refs) => findings.push({ rule, severity, message, refs: refs || [] });

    const enc = model.encoding;

    // ---- 图例完整性：图里用到的编码，编码表里必须有条目 ----
    const used = TopoCore.usedEncodings(model);
    const checkLegendGroup = (kind, tokens, table) => {
      for (const t of tokens) {
        const e = table[t];
        if (!e) add(`legend.${kind}-missing`, "error", `编码 ${kind}:${t} 在图中出现但未在编码表中定义`, [t]);
      }
    };
    checkLegendGroup("role", used.roles, enc.deviceRoles);
    checkLegendGroup("linkType", used.linkTypes, enc.linkTypes);
    checkLegendGroup("connType", used.connTypes, enc.connTypes);

    // ---- 命名规范 ----
    // decorative（如 "…" 省略标记）不是真实设备，不代表任何网络实体，命名规则不适用于它们。
    const realDevices = model.devices.filter(d => !(enc.deviceRoles[d.role] || {}).decorative);
    const idCount = {};
    for (const d of realDevices) idCount[d.id] = (idCount[d.id] || 0) + 1;
    const reportedDupIds = new Set();
    for (const d of realDevices) {
      if (idCount[d.id] > 1 && !reportedDupIds.has(d.id)) {
        reportedDupIds.add(d.id);
        add("naming.duplicate-id", "error", `设备 id "${d.id}" 重复出现 ${idCount[d.id]} 次`, [d.id]);
      }
      if (!d.label || !String(d.label).trim()) add("naming.missing-label", "error", `设备 ${d.id} 缺少 label`, [d.id]);
    }

    // ---- 评分：100 起步，error -10 / warn -3，clamp [0,100] ----
    let score = 100;
    for (const f of findings) score -= f.severity === "error" ? 10 : 3;
    score = Math.max(0, Math.min(100, score));

    const order = { error: 0, warn: 1 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);

    return { score, findings };
  }

  const API = { runDRC };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.TopoDRC = API;
})(typeof window !== "undefined" ? window : this);
