'use strict';
// The scheduler's reason why a pending item does not start yet (projects.json pendingItems[].blocked), or null.
// An update hold applies to every pending item, also one already assigned to a tab (it is not started until the
// restart either), so the 見回り 「始まらない」 does not list it. hold: { code, text } | null; waitingReason: { code, text } | null.
function blockedOf(item, hold, waitingReason) {
  if (!item || item.status !== 'pending') return null;
  if (hold) return { ...hold };
  return waitingReason ? { code: waitingReason.code, text: waitingReason.text } : null;
}
module.exports = { blockedOf };
