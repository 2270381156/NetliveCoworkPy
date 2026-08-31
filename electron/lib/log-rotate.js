'use strict';
const fs = require('fs');

// Startup-time rotation: electron.log is opened with flags:'a' and would grow
// unbounded across runs. Called BEFORE the write stream is opened, so rename
// is safe (no open handle on Windows).
function rotateIfNeeded({ logPath, maxBytes = 2 * 1024 * 1024, fsImpl = fs }) {
  try {
    const st = fsImpl.statSync(logPath);
    if (st.size <= maxBytes) return false;
    const rotated = logPath + '.1';
    if (fsImpl.existsSync(rotated)) fsImpl.unlinkSync(rotated);
    fsImpl.renameSync(logPath, rotated);
    return true;
  } catch (_) {
    return false; // missing file / locked / any fs error → just keep appending
  }
}

module.exports = { rotateIfNeeded };
