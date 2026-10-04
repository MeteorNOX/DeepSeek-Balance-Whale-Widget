(function (host) {
  'use strict';
  const KEY = 'dshw-account-notices-shown';
  function create({ fetchImpl = fetch, storage = localStorage, enabled, enqueue }) {
    let busy = false, scope = '', queued = null, seen = {}, generation = 0;
    const acknowledgements = new Map();
    try { const value = JSON.parse(storage.getItem(KEY) || '{}'); if (value && !Array.isArray(value) && typeof value === 'object') seen = value; } catch {}
    async function ack(id) {
      if (acknowledgements.has(id)) return acknowledgements.get(id);
      const job = (async () => {
        try {
          const r = await fetchImpl('/api/account-notices/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
          const data = await r.json(); return r.ok && data?.ok === true;
        } catch { return false; }
      })();
      acknowledgements.set(id, job);
      try { return await job; } finally { acknowledgements.delete(id); }
    }
    function invalidate() { generation++; scope = ''; queued = null; }
    async function poll() {
      if (busy || !enabled()) return;
      busy = true;
      const ticket = generation;
      try {
        const r = await fetchImpl('/api/account-notices', { cache: 'no-store' });
        const data = await r.json();
        if (ticket !== generation) return;
        if (!r.ok || data?.ok !== true || typeof data.scope !== 'string' || !Array.isArray(data.notices)) return;
        if (scope !== data.scope) { scope = data.scope; queued = null; }
        if (!enabled()) return;
        for (const n of data.notices.slice(0, 1)) {
          if (!n || n.scope !== scope || typeof n.id !== 'string' || !Number.isFinite(n.amount) || n.amount <= 0 || !/^[A-Z]{3}$/.test(n.currency)) continue;
          if (seen[n.scope] === n.id) { await ack(n.id); continue; }
          if (queued?.id === n.id) continue;
          const item = Object.freeze({ ...n });
          const valid = () => ticket === generation && enabled() && scope === item.scope && queued?.id === item.id;
          queued = item;
          const accepted = enqueue(item, {
            valid,
            shown() {
              if (!valid()) return;
              // Persist the visual commit before acknowledging. A retried GET
              // after a lost ACK only retries confirmation, never replays money.
              seen[item.scope] = item.id;
              const keys = Object.keys(seen); for (const key of keys.slice(0, Math.max(0, keys.length - 32))) delete seen[key];
              try { storage.setItem(KEY, JSON.stringify(seen)); } catch {}
              if (queued?.id === item.id) queued = null;
              void ack(item.id);
            },
            discarded() { if (queued?.id === item.id) queued = null; }
          });
          if (accepted === false && queued?.id === item.id) queued = null;
        }
      } catch {} finally { busy = false; }
    }
    return Object.freeze({ poll, invalidate });
  }
  host.WhaleAccountNotices = Object.freeze({ create });
})(typeof globalThis === 'object' ? globalThis : this);
