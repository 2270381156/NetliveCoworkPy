'use strict';

// Pure reconciliation of the persisted app-config.json (lives in AppData, seeded
// from the bundled factory copy) toward the current build's factory shape on every
// launch. No fs/electron access — caller passes parsed objects.
//
// policy:
//   force (URL keys) — always set to the factory value, overwriting whatever the
//                      user copy holds (cloud endpoints track the build).
//   preserve (everything else, e.g. `channel`) — keep the user copy's value; only
//                      fall back to factory when the user copy lacks the key. New
//                      factory keys are added.

// substrateBaseUrl 也是 force：它是"每套部署一个、跟着构建走"的常量（需求 B3），
// 与 netcoworkBaseUrl 同一生命周期。做成 preserve 的话，换环境重打包之后，
// 老机器上那份用户副本仍指着旧 substrate —— 表现是"新版装上了但阵容还是旧的"，
// 而且不报错。
const APP_CONFIG_FORCE_KEYS = ['netcoworkBaseUrl', 'substrateBaseUrl', 'feedUrl', 'telemetryUrl'];

function reconcileAppConfig(userConfig, factoryConfig) {
  const user = userConfig && typeof userConfig === 'object' ? userConfig : {};
  const factory = factoryConfig && typeof factoryConfig === 'object' ? factoryConfig : {};
  // Start from factory so brand-new factory keys are added, overlay the user's values
  // (preserves `channel` + any user-tuned keys), then re-force the URL keys to factory.
  const out = { ...factory, ...user };
  for (const k of APP_CONFIG_FORCE_KEYS) {
    if (k in factory) out[k] = factory[k];
  }
  return out;
}

module.exports = { reconcileAppConfig, APP_CONFIG_FORCE_KEYS };
