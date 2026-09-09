// Turning a session log back into an explanation.
//
// The app already writes one JSON object per event to logs/session-*.jsonl,
// which is the right thing to WRITE and the wrong thing to READ: an hour of use
// is tens of thousands of lines, and the question anyone actually arrives with
// is "why did these forty tracks not download". This reconstructs that answer -
// per-track chains, which store is failing and how, and what went wrong - so the
// file that gets handed over leads with the diagnosis and keeps the raw events
// underneath it as evidence.
//
// Pure and dependency-free on purpose: the summary is the part worth testing,
// and it must not need Electron, a filesystem, or a running app to run.

/** Events whose payload is noise in a summary, however useful in the raw log. */
const CHATTER = new Set(['download.progress', 'cache.hit', 'http.json']);

/**
 * The severity of an event, from its name alone.
 *
 * Call sites do not pass a level and should not have to - there are fifty of
 * them and they would drift. The names are already a convention (`.error`,
 * `.failed`), so the convention is what gets read. An unknown name is `info`,
 * never dropped: a summary that silently ignores events it has not been taught
 * about is exactly the summary that hides a new bug.
 */
export function levelOf(evt) {
  const name = String(evt || '');
  if (/(^|\.)(error|crash|uncaught|unhandled)($|\.)/.test(name)) return 'error';
  if (/\.(failed|error)$/.test(name)) return 'error';
  if (/\.(blocked|unsupported|unavailable|interrupted|timeout|warn)$/.test(name)) return 'warn';
  if (CHATTER.has(name)) return 'debug';
  return 'info';
}

const num = (v) => (Number.isFinite(v) ? v : 0);
const at = (e) => e.ts || null;

/** The one line that identifies a problem, so two of the same cluster. */
function problemKey(e) {
  const msg = String(e.message || e.reason || e.outcome || '').slice(0, 120);
  return `${e.evt}|${msg}`;
}

/**
 * Everything the report needs, in one pass over the events.
 *
 * Order matters and is preserved: a track's attempts are the order they were
 * tried in, which is the whole story of a fallback chain. Nothing is sorted by
 * severity here - that is a rendering decision, and doing it in the data would
 * lose the timeline.
 */
export function summarize(events) {
  const list = Array.isArray(events) ? events : [];
  const byEvent = new Map();
  const problems = new Map();
  const tracks = new Map();
  const services = new Map();
  const counts = { total: list.length, error: 0, warn: 0, info: 0, debug: 0 };

  let session = null;
  let ended = null;
  const downloads = { started: 0, completed: 0, interrupted: 0, cancelled: 0, bytes: 0 };

  const track = (id, name) => {
    if (!id) return null;
    let t = tracks.get(id);
    if (!t) {
      t = { id, name: name || null, attempts: [], result: 'unfinished', via: null, reason: null, tried: [] };
      tracks.set(id, t);
    }
    if (name && !t.name) t.name = name;
    return t;
  };

  for (const e of list) {
    if (!e || typeof e.evt !== 'string') continue;
    byEvent.set(e.evt, (byEvent.get(e.evt) || 0) + 1);
    const level = levelOf(e.evt);
    counts[level]++;

    if (level === 'error' || level === 'warn') {
      const key = problemKey(e);
      const p = problems.get(key);
      if (p) { p.n++; p.lastAt = at(e) || p.lastAt; }
      else {
        problems.set(key, {
          evt: e.evt, level, n: 1, firstAt: at(e), lastAt: at(e),
          message: e.message || e.reason || e.outcome || null,
          // Kept whole rather than summarised: the field that explains a
          // failure is rarely the one you predicted you would need.
          sample: e,
        });
      }
    }

    switch (e.evt) {
      case 'session.start': session = e; break;
      case 'session.end': ended = e; break;

      case 'attempt.outcome': {
        const t = track(e.id, e.name);
        if (t) t.attempts.push({ service: e.service || null, outcome: e.outcome || null, ms: num(e.ms), message: e.message || null });
        if (e.service) {
          const s = services.get(e.service) || { service: e.service, attempts: 0, found: 0, ms: 0, outcomes: {} };
          s.attempts++;
          s.ms += num(e.ms);
          s.outcomes[e.outcome || 'unknown'] = (s.outcomes[e.outcome || 'unknown'] || 0) + 1;
          // "download" and "transferring" both mean the store produced a file;
          // everything else means the chain had to move on.
          if (e.outcome === 'download' || e.outcome === 'transferring') s.found++;
          services.set(e.service, s);
        }
        break;
      }
      case 'attempt.error': {
        const t = track(e.id, e.name);
        if (t) t.attempts.push({ service: e.service || null, outcome: 'error', ms: 0, message: e.message || null });
        break;
      }
      case 'done': {
        const t = track(e.id, e.name);
        if (t) { t.result = 'downloaded'; t.via = e.service || e.via || null; }
        break;
      }
      case 'skip': {
        const t = track(e.id, e.name);
        if (t) { t.result = 'missing'; t.reason = e.reason || null; t.tried = e.tried || []; }
        break;
      }
      case 'download.start': downloads.started++; break;
      case 'download.done':
        downloads.completed++;
        downloads.bytes += num(e.bytes || e.received || e.total);
        break;
      case 'download.interrupted': downloads.interrupted++; break;
      case 'download.cancel': downloads.cancelled++; break;
      default: break;
    }
  }

  const serviceRows = [...services.values()]
    .map((s) => ({ ...s, avgMs: s.attempts ? Math.round(s.ms / s.attempts) : 0, hitRate: s.attempts ? s.found / s.attempts : 0 }))
    .sort((a, b) => b.attempts - a.attempts);

  return {
    session: session
      ? {
        startedAt: session.ts || null,
        endedAt: ended ? ended.ts : null,
        uptimeMs: ended ? num(ended.uptimeMs) : (list.length ? num(list[list.length - 1].t) : 0),
        app: session.electron ? { electron: session.electron, chrome: session.chrome, node: session.node, platform: session.platform, arch: session.arch } : null,
        downloadPath: session.downloadPath || null,
        stateDir: session.stateDir || null,
      }
      : null,
    counts,
    events: [...byEvent.entries()].map(([evt, n]) => ({ evt, n, level: levelOf(evt) })).sort((a, b) => b.n - a.n),
    problems: [...problems.values()].sort((a, b) => (b.level === a.level ? b.n - a.n : (b.level === 'error' ? 1 : -1))),
    tracks: [...tracks.values()],
    services: serviceRows,
    downloads,
  };
}

// --- rendering --------------------------------------------------------------

const pct = (v) => `${Math.round(v * 100)}%`;
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

function bytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** A track's whole chain on one line: which stores were asked, and what each said. */
export function chainLine(t) {
  const steps = t.attempts.map((a) => `${a.service || '?'}:${a.outcome || '?'}`).join(' -> ');
  return steps || '(no attempt recorded)';
}

/** Anything that is nobody's business but the user's. */
export function redactConfig(config) {
  const out = { ...(config || {}) };
  for (const key of Object.keys(out)) {
    // Credentials are the only thing worth hiding here - the paths and the
    // service list are exactly what a diagnosis needs, so they stay.
    if (/token|secret|password|clientid|key$/i.test(key) && out[key]) out[key] = '(set, redacted)';
  }
  return out;
}

/**
 * The handover file.
 *
 * Markdown, and the diagnosis first: whoever opens this should be able to read
 * the top screen and know what happened, and only then scroll into the evidence.
 * The raw events go last, tail-first, because the end of a session is where the
 * failure usually is.
 */
export function renderReport({ summary, config, raw = [], notes = null, generatedAt = new Date().toISOString() }) {
  const s = summary;
  const out = [];
  const line = (...t) => out.push(t.join(''));

  line('# LucidaFetcher diagnostics');
  line('');
  line(`Generated ${generatedAt}`);
  if (notes) { line(''); line('> ', String(notes).replace(/\n/g, '\n> ')); }
  line('');

  // --- the verdict ---------------------------------------------------------
  const done = s.tracks.filter((t) => t.result === 'downloaded').length;
  const missing = s.tracks.filter((t) => t.result === 'missing').length;
  const open = s.tracks.filter((t) => t.result === 'unfinished').length;
  line('## Summary');
  line('');
  line(`- **${s.tracks.length} tracks** seen: ${done} downloaded, ${missing} missing, ${open} still unfinished when the log ended`);
  line(`- **${s.counts.error} errors**, ${s.counts.warn} warnings, ${s.counts.total} events total`);
  line(`- **${s.downloads.completed} files** landed (${bytes(s.downloads.bytes)}); `
    + `${s.downloads.started} started, ${s.downloads.interrupted} interrupted, ${s.downloads.cancelled} cancelled`);
  if (s.session) {
    line(`- Session ran ${ms(s.session.uptimeMs)}${s.session.endedAt ? '' : ' (still open - the app did not log a clean exit)'}`);
  }
  line('');

  // --- environment ---------------------------------------------------------
  if (s.session) {
    line('## Environment');
    line('');
    line('```');
    if (s.session.app) {
      line(`platform      ${s.session.app.platform} ${s.session.app.arch}`);
      line(`electron      ${s.session.app.electron}   chrome ${s.session.app.chrome}   node ${s.session.app.node}`);
    }
    line(`started       ${s.session.startedAt}`);
    line(`downloads to  ${s.session.downloadPath}`);
    line(`state in      ${s.session.stateDir}`);
    line('```');
    line('');
  }

  if (config) {
    line('## Settings');
    line('');
    line('```json');
    line(JSON.stringify(redactConfig(config), null, 2));
    line('```');
    line('');
  }

  // --- what went wrong -----------------------------------------------------
  line('## What went wrong');
  line('');
  if (!s.problems.length) {
    line('Nothing logged an error or a warning this session.');
  } else {
    // Clustered, because one broken thing produces four hundred identical
    // lines and a list of four hundred lines is not a diagnosis.
    line('| n | level | event | message |');
    line('|---|-------|-------|---------|');
    for (const p of s.problems.slice(0, 40)) {
      line(`| ${p.n} | ${p.level} | \`${p.evt}\` | ${String(p.message || '').replace(/\|/g, '\\|').slice(0, 160)} |`);
    }
    line('');
    line('<details><summary>First occurrence of each, in full</summary>');
    line('');
    line('```json');
    for (const p of s.problems.slice(0, 20)) line(JSON.stringify(p.sample));
    line('```');
    line('');
    line('</details>');
  }
  line('');

  // --- which store is actually working -------------------------------------
  line('## Sources');
  line('');
  if (!s.services.length) {
    line('No search attempt was recorded.');
  } else {
    line('How often each source produced a file, and how long it took to answer.');
    line('');
    line('| source | attempts | produced a file | hit rate | avg time | outcomes |');
    line('|--------|----------|-----------------|----------|----------|----------|');
    for (const sv of s.services) {
      const outcomes = Object.entries(sv.outcomes).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`).join(', ');
      line(`| ${sv.service} | ${sv.attempts} | ${sv.found} | ${pct(sv.hitRate)} | ${ms(sv.avgMs)} | ${outcomes} |`);
    }
  }
  line('');

  // --- the tracks that did not make it -------------------------------------
  const failed = s.tracks.filter((t) => t.result !== 'downloaded');
  line('## Tracks that did not download');
  line('');
  if (!failed.length) {
    line('Every track seen in this log was downloaded.');
  } else {
    line(`${failed.length} of ${s.tracks.length}. The chain is every source tried, in order.`);
    line('');
    for (const t of failed.slice(0, 100)) {
      line(`- **${t.name || t.id}** — ${t.result}${t.reason ? `: ${t.reason}` : ''}`);
      line(`  - \`${chainLine(t)}\``);
    }
    if (failed.length > 100) line(`- …and ${failed.length - 100} more.`);
  }
  line('');

  // --- event census --------------------------------------------------------
  line('## Every event type seen');
  line('');
  line('```');
  for (const e of s.events) line(`${String(e.n).padStart(6)}  ${e.evt}`);
  line('```');
  line('');

  // --- evidence ------------------------------------------------------------
  if (raw.length) {
    line(`## Raw events (last ${raw.length})`);
    line('');
    line('```json');
    for (const e of raw) line(typeof e === 'string' ? e : JSON.stringify(e));
    line('```');
  }

  return out.join('\n') + '\n';
}
