/* 从 drawing-engine/topology-icons/catalog.json 生成 topology-drawing 技能的图标参考页。

   为什么要生成而不是手写：图标目录会随着补图标而变，手写的那份必然漂移——本项目已经
   因为"两处各自维护同一份认知"栽过（style-report 自己臆断哪些 glyph 画得出来，给出了
   假的全清）。这里让 catalog.json 是唯一事实来源，参考页是它的投影。

   用法：
     node gen-icon-reference.js            # 写入技能的 references/icon-catalog.md
     node gen-icon-reference.js --check    # 只校验磁盘上那份是否与当前 catalog 一致（CI/verify 用）

   参考页刻意只带 key / 中文名 / 是否支持 iconTheme —— 挑图标只需要这些。svg 路径、
   category 之类是引擎自己读 catalog.json 时用的，塞进来只会占 agent 的上下文。 */
"use strict";
const fs = require("fs");
const path = require("path");

const CATALOG = path.join(__dirname, "topology-icons", "catalog.json");
const OUT = path.join(__dirname, "..", "resources", "skills", "topology-drawing",
                      "references", "icon-catalog.md");

// category → 人类可读的中文小标题；catalog 里出现的新类别若没登记，回落到原始英文
const CATEGORY_ZH = {
  switch: "交换机", router: "路由器", security: "安全设备", wireless: "无线",
  cloud: "云 / 虚拟化", server: "服务器与存储", client: "终端",
  generic: "通用", management: "管理",
};

function build() {
  const raw = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  const icons = raw.icons || raw;

  const byCat = new Map();
  for (const [key, v] of Object.entries(icons)) {
    if (!byCat.has(v.category)) byCat.set(v.category, []);
    byCat.get(v.category).push({ key, zh: v.legend_zh, device: !!v.deviceType });
  }

  const noYellow = Object.entries(icons).filter(([, v]) => !v.deviceType).map(([k]) => k);

  const L = [];
  L.push("<!-- 本文件由 drawing-engine/gen-icon-reference.js 从 drawing-engine/topology-icons/catalog.json 生成，不要手改。 -->");
  L.push("<!-- 改图标目录请改 catalog.json 后重新生成；verify-icon-reference.js 会校验两者是否一致。 -->");
  L.push("");
  L.push("# 图标目录");
  L.push("");
  L.push(`共 ${Object.keys(icons).length} 个 key。按语义挑，不要跟角色名做字符串匹配。`);
  L.push("");
  for (const [cat, list] of byCat) {
    L.push(`## ${CATEGORY_ZH[cat] || cat}`);
    L.push("");
    for (const it of list) L.push(`- \`${it.key}\` — ${it.zh}`);
    L.push("");
  }
  L.push("## iconTheme 的例外");
  L.push("");
  L.push(`下面 ${noYellow.length} 个 key 只有蓝色版、没有黄色版，`
       + `设 \`iconTheme: "yellow"\` 对它们不生效（它们不是"设备"）：`
       + noYellow.map(k => `\`${k}\``).join("、") + "。");
  L.push("");
  return L.join("\n");
}

const content = build();

if (process.argv.includes("--check")) {
  if (!fs.existsSync(OUT)) {
    console.error(`✗ 参考页不存在：${OUT}\n  跑 node gen-icon-reference.js 生成`);
    process.exit(1);
  }
  const disk = fs.readFileSync(OUT, "utf8");
  if (disk.replace(/\r\n/g, "\n") !== content) {
    console.error("✗ references/icon-catalog.md 与 catalog.json 不一致（catalog 改了但没重新生成）\n"
                + "  跑 node gen-icon-reference.js 重新生成");
    process.exit(1);
  }
  console.log("✓ 图标参考页与 catalog.json 一致");
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, content, "utf8");
  console.log(`已生成 ${OUT}（${Buffer.byteLength(content, "utf8")} 字节）`);
}
