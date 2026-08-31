/* 样例拓扑数据（与 sample-dual-core.topo.json 内容一致）。
   以 classic script 形式提供：浏览器里挂到 window.TOPO；node 里 module.exports。
   注意：设备/链路里没有任何坐标——坐标全部由布局派生。 */
(function (root) {
  const TOPO = {
    meta: { name: "双核心园区（样例）", layoutDirection: "TB" },

    encoding: {
      deviceRoles: {
        internet: { w: 74, h: 40, fill: "#e8eef7", stroke: "#7c93b0", glyph: "cloud",  legend: "Internet", icon: "internet" },
        router:   { w: 80, h: 46, fill: "#eef2fb", stroke: "#6b83c9", glyph: "switch", legend: "边界路由器", critical: true, icon: "generic-router" },
        firewall: { w: 80, h: 46, fill: "#fde8e8", stroke: "#d98a8a", glyph: "fw",     legend: "防火墙", critical: true, icon: "firewall" },
        core:     { w: 80, h: 46, fill: "#e7f3ec", stroke: "#5aa27a", glyph: "switch", legend: "核心交换机", critical: true, icon: "core-switch" },
        agg:      { w: 80, h: 46, fill: "#eef1f4", stroke: "#8aa0b4", glyph: "switch", legend: "汇聚交换机", icon: "agg-switch" },
        access:   { w: 48, h: 28, fill: "#eef1f4", stroke: "#8aa0b4", glyph: "switch", legend: "接入交换机", icon: "access-switch" },
        ellipsis: { w: 30, h: 28, fill: "none", stroke: "none", glyph: "ellipsis", legend: "省略（同组更多设备）", decorative: true }
      },
      linkTypes: {
        normal: { stroke: "#5b6b7c", width: 1.6, dash: null,  bundle: 1, legend: "普通链路" },
        trunk:  { stroke: "#2f6f4f", width: 1.8, dash: null,  bundle: 2, legend: "Trunk（双线）" },
        ha:     { stroke: "#b06a2c", width: 1.6, dash: "5,4", bundle: 1, legend: "HA 横链" }
      },
      connTypes: {
        uplink:      { shape: "circle", fill: "#10b981", legend: "上行口" },
        "dcn-10ge":  { shape: "circle", fill: "#3b82f6", legend: "DCN 10GE" },
        "dci-100ge": { shape: "square", fill: "#ef4444", legend: "DCI 100GE" }
      },
      zoneTypes: {
        server:  { stroke: "#5a8fc9", fill: "#eaf1fb", legend: "服务器区域" },
        storage: { stroke: "#5a8fc9", fill: "#eaf1fb", legend: "存储区域" }
      }
    },

    devices: [
      { id: "INET",  role: "internet", tier: 0, label: "Internet" },
      { id: "FW1",   role: "firewall", tier: 1, label: "FW-1", satelliteOf: "RT1" },
      { id: "RT1",   role: "router",   tier: 1, label: "RT-1", haPair: "RT2" },
      { id: "RT2",   role: "router",   tier: 1, label: "RT-2", haPair: "RT1" },
      { id: "CORE1", role: "core",     tier: 2, label: "Core-1", haPair: "CORE2" },
      { id: "CORE2", role: "core",     tier: 2, label: "Core-2", haPair: "CORE1" },
      { id: "AGG1",  role: "agg",      tier: 3, label: "Agg-1" },
      { id: "AGG2",  role: "agg",      tier: 3, label: "Agg-2" },
      { id: "ACC1",  role: "access",   tier: 4, label: "Acc-1" },
      { id: "ACC2",  role: "access",   tier: 4, label: "Acc-2" },
      { id: "MORE1", role: "ellipsis", tier: 4, label: "…" },
      { id: "ACC3",  role: "access",   tier: 4, label: "Acc-3" },
      { id: "ACC4",  role: "access",   tier: 4, label: "Acc-4" },
      { id: "ACC5",  role: "access",   tier: 4, label: "Acc-5" },
      { id: "MORE2", role: "ellipsis", tier: 4, label: "…" },
      { id: "ACC6",  role: "access",   tier: 4, label: "Acc-6" }
    ],

    links: [
      { a: "INET",  b: "RT1",   type: "normal", aConn: "uplink", bConn: "uplink" },
      { a: "INET",  b: "RT2",   type: "normal", aConn: "uplink", bConn: "uplink" },
      { a: "RT1",   b: "RT2",   type: "ha" },
      { a: "RT1",   b: "FW1",   type: "normal" },
      { a: "RT1",   b: "CORE1", type: "trunk",  aConn: "dci-100ge" },
      { a: "RT1",   b: "CORE2", type: "trunk",  aConn: "dci-100ge" },
      { a: "RT2",   b: "CORE1", type: "trunk",  aConn: "dci-100ge" },
      { a: "RT2",   b: "CORE2", type: "trunk",  aConn: "dci-100ge" },
      { a: "CORE1", b: "CORE2", type: "ha" },
      { a: "CORE1", b: "AGG1",  type: "trunk",  aConn: "dcn-10ge" },
      { a: "CORE1", b: "AGG2",  type: "trunk",  aConn: "dcn-10ge" },
      { a: "CORE2", b: "AGG1",  type: "trunk",  aConn: "dcn-10ge" },
      { a: "CORE2", b: "AGG2",  type: "trunk",  aConn: "dcn-10ge" },
      { a: "AGG1",  b: "ACC1",  type: "normal" },
      { a: "AGG1",  b: "ACC2",  type: "normal" },
      { a: "AGG1",  b: "ACC3",  type: "normal" },
      { a: "AGG2",  b: "ACC4",  type: "normal" },
      { a: "AGG2",  b: "ACC5",  type: "normal" },
      { a: "AGG2",  b: "ACC6",  type: "normal" }
    ],

    // Zone：纯语义分组（哪些设备属于这个区域），边框/位置全部在布局阶段派生，
    // 不在这里写坐标——按 DCN 划分，Agg-1 这组是服务器区域、Agg-2 这组是存储区域。
    // zone 的 tier 取成员里最小的 tier 值,让 zone 这一整行贴着它"最上层"的成员所在的行,避免跟同 tier 的无关设备撞在一起。
    zones: [
      { id: "ZONE_SVR", type: "server",  label: "服务器区域", layout: "row", tier: 3,
        members: ["AGG1", "ACC1", "ACC2", "MORE1", "ACC3"] },
      { id: "ZONE_STG", type: "storage", label: "存储区域", layout: "row", tier: 3,
        members: ["AGG2", "ACC4", "ACC5", "MORE2", "ACC6"] }
    ]
  };

  if (typeof module !== "undefined" && module.exports) module.exports = TOPO;
  else root.TOPO = TOPO;
})(typeof window !== "undefined" ? window : this);
