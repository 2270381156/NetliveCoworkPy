'use strict';

// Pure GC planner for bundled-resource seeding. Decides which previously-seeded
// entries to retire now that the bundle no longer ships them. No fs access — the
// caller supplies the on-disk state and applies the plan.
//
// The seed manifest is the ownership ledger: an entry recorded there was installed
// BY US. So an entry that is in the ledger but absent from the current bundle is a
// retired internal item. User-added/pulled dirs were never in the ledger and thus
// never appear here — they can't be touched.
//
//   seededHashes:  { [entry]: hash }  — manifest record of what we last wrote.
//   bundleEntries: string[]           — entries the current bundle ships.
//   destState:     { [entry]: { exists: boolean, hash: string|null } }
//                  current on-disk state of each candidate (only retired ones matter).
//
// Returns { toDelete, toRelease, toForget }:
//   toDelete  — pristine (dest exists and hash == seeded hash): safe to rm.
//   toRelease — user-modified (hash drifted): keep on disk, just stop tracking.
//   toForget  — every retired entry (incl. already-vanished): drop from manifest.
function planRetirement({ seededHashes = {}, bundleEntries = [], destState = {} } = {}) {
  const shipped = new Set(bundleEntries);
  const toDelete = [];
  const toRelease = [];
  const toForget = [];
  for (const entry of Object.keys(seededHashes)) {
    if (shipped.has(entry)) continue;            // still bundled — not retired
    toForget.push(entry);
    const st = destState[entry] || { exists: false, hash: null };
    if (st.exists && st.hash === seededHashes[entry]) toDelete.push(entry);
    else if (st.exists) toRelease.push(entry);   // user edited it → keep, untrack
    // !exists → already gone; nothing to delete/release, just forget.
  }
  return { toDelete, toRelease, toForget };
}

module.exports = { planRetirement };
