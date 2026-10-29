// Bounded single-flight requests. Never use this for signed download URLs.
export function resourceCache(load, { concurrency = 4, maxEntries = 64, ttl = 60000,
  maxBytes = 32 * 1024 * 1024, sizeOf = () => 1, now = Date.now } = {}) {
  const entries = new Map(), pending = new Map(), queue = [];
  let active = 0, bytes = 0;
  const remove = key => { bytes -= entries.get(key)?.size || 0; entries.delete(key); };
  const pump = () => {
    while (active < concurrency && queue.length) {
      const { key, resolve, reject } = queue.shift(); active++;
      Promise.resolve().then(() => load(key)).then(value => {
        const size = sizeOf(value);
        if (size <= maxBytes) {
          remove(key); entries.set(key, { value, size, until: now() + ttl }); bytes += size;
          for (const oldKey of entries.keys()) {
            if (entries.size <= maxEntries && bytes <= maxBytes) break;
            remove(oldKey);
          }
        }
        return value;
      }).then(resolve, reject).finally(() => { active--; pending.delete(key); pump(); });
    }
  };
  return key => {
    const cached = entries.get(key);
    if (cached && cached.until > now()) return Promise.resolve(cached.value);
    if (cached) remove(key);
    if (pending.has(key)) return pending.get(key);
    const promise = new Promise((resolve, reject) => queue.push({ key, resolve, reject }));
    pending.set(key, promise); pump(); return promise;
  };
}
