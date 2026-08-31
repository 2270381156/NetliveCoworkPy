'use strict';
const { buildEvent, enqueue } = require('./lib/telemetry-core');

// createReporter(deps) returns { report, flush }. Side effects (HTTP, queue
// persistence) are injected so drain logic is unit-testable. In production,
// main.js passes the global fetch and AppData-backed loadQueue/saveQueue.
function createReporter({ endpoint, context, loadQueue, saveQueue, fetchImpl = fetch }) {
  let queue = loadQueue() || [];

  async function flush() {
    if (!endpoint || queue.length === 0) return;
    const pending = queue;
    queue = [];
    for (const ev of pending) {
      try {
        await fetchImpl(`${endpoint}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ev),
        });
      } catch (_) {
        queue = enqueue(queue, ev);
      }
    }
    saveQueue(queue);
  }

  async function report(eventType, extra) {
    if (!endpoint) return;
    queue = enqueue(queue, buildEvent(eventType, context, extra));
    saveQueue(queue);
    await flush();
  }

  return { report, flush };
}

module.exports = { createReporter };
