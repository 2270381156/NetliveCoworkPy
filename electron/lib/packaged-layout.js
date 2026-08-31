'use strict';

const path = require('path');

function detectPackagedLayout({ isPackaged, resourcesPath, existsSync }) {
  if (isPackaged) return true;
  if (!resourcesPath || typeof existsSync !== 'function') return false;
  return existsSync(path.join(resourcesPath, 'app.asar'));
}

module.exports = { detectPackagedLayout };
