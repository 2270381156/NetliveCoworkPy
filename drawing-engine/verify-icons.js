/* verify-icons.js 自测:用法 node verify-icons.js */
const fs = require("fs");
const path = require("path");
const { loadCatalog, resolveIconsForModel } = require("./icons.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

console.log("① catalog.json 加载、35 个条目、每条都有 category/legend_zh/deviceType/blue 字段");
{
  const catalog = loadCatalog();
  const keys = Object.keys(catalog);
  ok(keys.length === 35, `35 个条目(实际 ${keys.length})`);
  for (const k of keys) {
    const e = catalog[k];
    if (!e.category || !e.legend_zh || typeof e.deviceType !== "boolean" || !e.blue) {
      ok(false, `${k} 缺字段`); break;
    }
  }
  ok(true, "字段完整性检查通过");
}

console.log("② 只解析 model 里实际引用的 icon key,未引用的不出现在结果里");
{
  const model = { encoding: { deviceRoles: { core: { icon: "core-switch" }, leaf: {} } } };
  const icons = resolveIconsForModel(model);
  ok(Object.keys(icons).length === 1 && icons["core-switch"], "只解析了 core-switch 一个 key");
  ok(icons["core-switch"].blue.startsWith("data:image/svg+xml;base64,"), "blue 是合法 data URI");
  ok(icons["core-switch"].deviceType === true, "core-switch 的 deviceType 正确读出为 true");
}

console.log("③ deviceType:false 的角色即使 catalog 里有 yellow 源,也不应该在结果里带 yellow");
{
  // 真实 catalog.json 里 4 个 deviceType:false 条目(cloud-computing / network-cloud /
  // internet / admin)恰好全部 yellow:null,光测 "internet" 无法证明是"因为 deviceType
  // 为 false 而被压制",还是"本来就没有 yellow 素材"。所以这里往真实 catalog.json 里
  // 临时注入一个 deviceType:false 但 yellow 非空的合成条目,清掉 require 缓存拿到一份
  // "干净"的 icons.js,端到端跑一次真正的 resolveIconsForModel,再把文件还原——
  // 这样断言的是真实压制逻辑,而不是巧合。
  // 已知风险:如果测试进程在"写入合成 catalog.json"和 finally 里的"还原"之间被强制
  // 中断(Ctrl+C/崩溃),catalog.json 会残留 __test-synthetic-* 条目。概率很低,且
  // git status/git diff 会立刻暴露这种残留(外部安全网),这里不做额外的进程信号处理。
  const catalogPath = path.join(__dirname, "topology-icons", "catalog.json");
  const iconsPath = require.resolve("./icons.js");
  const originalRaw = fs.readFileSync(catalogPath, "utf8");
  try {
    const catalog = JSON.parse(originalRaw);
    catalog["__test-synthetic-false"] = {
      category: "test",
      legend_zh: "测试用合成条目",
      deviceType: false,
      blue: "svg/blue/internet.svg",   // 复用已存在的真实文件,避免额外造资产
      yellow: "svg/yellow/core-switch.svg", // 关键:yellow 非空,但 deviceType:false
    };
    catalog["__test-synthetic-true"] = {
      category: "test",
      legend_zh: "测试用合成条目(对照组)",
      deviceType: true,
      blue: "svg/blue/internet.svg",
      yellow: "svg/yellow/core-switch.svg",
    };
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

    delete require.cache[iconsPath];
    const fresh = require("./icons.js");
    const model = {
      encoding: {
        deviceRoles: {
          a: { icon: "__test-synthetic-false" },
          b: { icon: "__test-synthetic-true" },
        },
      },
    };
    const icons = fresh.resolveIconsForModel(model);
    ok(
      icons["__test-synthetic-false"].yellow === null,
      "deviceType:false + yellow 非空 的合成条目 → yellow 仍被压制为 null(证明压制确实由 deviceType 驱动)"
    );
    ok(
      typeof icons["__test-synthetic-true"].yellow === "string" &&
        icons["__test-synthetic-true"].yellow.startsWith("data:image/svg+xml;base64,"),
      "对照组 deviceType:true + yellow 非空 → yellow 正常解析为 data URI(证明上面不是因为读取失败才为 null)"
    );
  } finally {
    // 无论断言是否通过都要还原真实 catalog.json,并清掉缓存避免污染后续测试/其它进程
    fs.writeFileSync(catalogPath, originalRaw, "utf8");
    delete require.cache[iconsPath];
  }

  // 注意:顶部 require("./icons.js") 拿到的 resolveIconsForModel 绑定,其内部
  // loadCatalog() 的模块级 _catalog 缓存早在①里第一次调用时就已经被填充——那时
  // catalog.json 还没被本节 patch 过。所以如果直接复用顶部绑定来做"还原后"校验,
  // 读到的是"从一开始就没变过"的旧缓存,不管上面的还原有没有真正写盘成功,结果都
  // 会一样,是个假校验。这里必须再清一次 require 缓存、重新 require 一份"刚从磁盘
  // 读"的 icons.js,校验的才是真正落盘还原后的 catalog.json 内容。
  delete require.cache[iconsPath];
  const reloaded = require("./icons.js");
  const model = { encoding: { deviceRoles: { c: { icon: "internet" } } } };
  const icons = reloaded.resolveIconsForModel(model);
  ok(icons["internet"].yellow === null, "还原后(用新鲜 require 读磁盘上的真实文件):internet 的 yellow 仍是 null");
  ok(
    !("__test-synthetic-false" in reloaded.loadCatalog()) && !("__test-synthetic-true" in reloaded.loadCatalog()),
    "还原后:合成 key 不再存在于磁盘上的 catalog.json 里(证明还原真的落盘了,不是巧合)"
  );
  delete require.cache[iconsPath]; // 收尾:不让这份"新鲜"绑定的缓存影响后面④⑤两节
}

console.log("④ 未登记的 icon key 直接跳过,不抛异常");
{
  const model = { encoding: { deviceRoles: { c: { icon: "does-not-exist" } } } };
  let threw = false;
  let icons;
  try { icons = resolveIconsForModel(model); } catch (e) { threw = true; }
  ok(!threw, "未登记 key 不抛异常");
  ok(icons && Object.keys(icons).length === 0, "未登记 key 不出现在结果里");
}

console.log("⑤ 没有 icon 字段的模型,返回空对象");
{
  const model = { encoding: { deviceRoles: { c: { legend: "x" } } } };
  const icons = resolveIconsForModel(model);
  ok(Object.keys(icons).length === 0, "没有 icon 字段 → 空结果");
}

console.log("⑥ resolveIconsForModel 附带 aspect(宽/高),从 viewBox 解析,未登记 key 不受影响");
{
  const model = { encoding: { deviceRoles: { core: { icon: "core-switch" } } } };
  const icons = resolveIconsForModel(model);
  // core-switch.svg 真实 viewBox 是 "0 0 2751 2251"，2751/2251 ≈ 1.2221
  const expected = 2751 / 2251;
  ok(typeof icons["core-switch"].aspect === "number" && Math.abs(icons["core-switch"].aspect - expected) < 1e-6,
    `core-switch.aspect=${icons["core-switch"].aspect}(应≈${expected.toFixed(4)})`);
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
