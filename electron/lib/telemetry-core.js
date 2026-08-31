'use strict';

// Pure telemetry helpers. ctx.now() supplies the timestamp so tests are deterministic.
// extra is spread LAST so spool events can carry their own backend-side ts.
function buildEvent(eventType, ctx, extra = {}) {
  return {
    event_type: eventType,
    install_id: ctx.installId,
    app_version: ctx.appVersion,
    channel: ctx.channel,
    os: ctx.os,
    arch: ctx.arch,
    hostname: ctx.hostname,
    os_username: ctx.osUsername,
    ts: ctx.now(),
    ...extra,
  };
}

function enqueue(queue, event, maxLen = 200) {
  const next = [...queue, event];
  return next.length > maxLen ? next.slice(next.length - maxLen) : next;
}

function tailString(s, maxBytes) {
  if (!s) return '';
  return s.length <= maxBytes ? s : s.slice(s.length - maxBytes);
}

module.exports = { buildEvent, enqueue, tailString };
