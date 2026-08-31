'use strict';

// Pure planner for "mirror" seeding: force AppData/<name> to hold EXACTLY the
// bundled default entries. Any entry present on disk but not shipped by the bundle
// (user-added / pulled / retired) is scheduled for removal; every shipped entry is
// (re)written by the caller. No fs access — the caller supplies dir listings and
// applies the plan.
//
//   shipped: string[]  — entries the current bundle ships (the "default data").
//   present: string[]  — entries currently on disk in AppData/<name>.
//
// Returns { toRemove } — present entries absent from the bundle (order follows
// `present` so removal logs read in on-disk order).
function planMirror({ shipped = [], present = [] } = {}) {
  const keep = new Set(shipped);
  return { toRemove: present.filter((e) => !keep.has(e)) };
}

module.exports = { planMirror };
