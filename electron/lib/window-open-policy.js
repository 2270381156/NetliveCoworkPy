'use strict';

function safeUrlForLog(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'data:') return 'data:';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

module.exports = { safeUrlForLog };
