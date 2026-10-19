'use strict';

// Prod write path (liturgio-api #1): on a read-only deployment Save becomes
// "Submit edit", which records the change in /api/edit_queue for review
// instead of writing it, and the user's pending edits are shown on top of the
// live data, marked "pending review". Local (read-write) keeps direct Save.
// Needs auth.js (window.currentUser).
window.editQueue = (function () {
  async function call(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
      } catch (_) {}
      throw new Error(detail);
    }
    return res.json();
  }

  async function readOnly() {
    const user = await window.currentUser;
    return !!(user && user.read_only);
  }

  // newValues is the same body the direct save sends; the server stores only
  // the columns that change, so the returned new_values are column values.
  function submit(table, pk, newValues) {
    return call('/api/edit_queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_table: table, target_pk: pk, new_values: newValues }),
    });
  }

  // Map of String(pk value) -> merged column values of the user's pending
  // edits on that row (oldest first, so later edits win). Empty when the
  // queue is unavailable, so the page still shows live data.
  async function pending(table) {
    const out = new Map();
    let edits = [];
    try {
      edits = await call(`/api/edit_queue?mine=true&status=pending&target_table=${encodeURIComponent(table)}`);
    } catch (e) {
      console.warn('Pending edits unavailable:', e.message);
    }
    for (const e of edits) record(out, e);
    return out;
  }

  // Fold one queued edit (e.g. a fresh submit response) into a pending() map.
  function record(map, edit) {
    const key = String(Object.values(edit.target_pk)[0]);
    map.set(key, { ...(map.get(key) || {}), ...edit.new_values });
  }

  return { readOnly, submit, pending, record };
})();
