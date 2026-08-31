'use strict';

// Pure diff for version-aware seeding. No fs/electron access.
// Caller applies filesToCopy / envKeysToAdd when versionChanged is true
// (which also covers first install where installedVersion is null/absent).
function planSeedMigration({
  installedVersion = null,
  currentVersion,
  bundledConfigFiles = [],
  existingConfigFiles = [],
  bundledEnvKeys = [],
  existingEnvKeys = [],
} = {}) {
  const versionChanged = installedVersion !== currentVersion;
  const haveFile = new Set(existingConfigFiles);
  const haveEnv = new Set(existingEnvKeys);
  return {
    versionChanged,
    filesToCopy: bundledConfigFiles.filter((f) => !haveFile.has(f)),
    envKeysToAdd: bundledEnvKeys.filter((k) => !haveEnv.has(k)),
  };
}

module.exports = { planSeedMigration };
