// The renderer's half of the logging system.
//
// Two jobs, both of which only this side can do.
//
// First, capture. The main process is the only writer of the session log, but
// it cannot see anything that happens in here - a React render that throws, a
// promise nobody awaited, a `console.error` from a library. Before this, all of
// that went to a DevTools console nobody had open, which meant the single most
// common kind of failure left no trace at all. It is forwarded over the same
// `log` channel every other renderer event already uses, so ordering with the
// main process's own events is preserved and there is still exactly one writer.
//
// Second, rendering the report. The summariser lives in src/engine and is
// bundled into this UI by Vite; a packaged build ships no loose files under
// src/, so the renderer is the side that has it. Main collects the events and
// writes the file - it owns both - and this turns one into the other.

import { summarize, renderReport } from '../engine/diagnostics.mjs';

const MAX_ARG = 400;

/** console arguments as one string, without letting an Error lose its stack. */
function flatten(args) {
  return args.map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ').slice(0, MAX_ARG);
}

const stackOf = (err) => String((err && err.stack) || '').split('\n').slice(0, 8).join(' | ');

let installed = false;

/**
 * Start forwarding renderer failures to the session log.
 *
 * Called before React mounts, on purpose: an exception thrown while the app is
 * booting is the one most worth having, and it happens before any component
 * could install a handler. The original console methods are still called, so
 * DevTools behaves exactly as it did.
 */
export function installRendererLogging(send) {
  if (installed) return;
  installed = true;

  const forward = (evt, data) => {
    // The logger must never be able to break the thing it is logging.
    try { send(evt, data); } catch (e) { /* nothing useful left to do here */ }
  };

  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const err = args.find((a) => a instanceof Error);
      forward('ui.console', {
        level,
        message: flatten(args),
        stack: err ? stackOf(err) : null,
      });
    };
  }

  window.addEventListener('error', (event) => {
    forward('error.renderer', {
      message: event.message || String(event.error || 'unknown'),
      source: event.filename || null,
      line: event.lineno || null,
      stack: stackOf(event.error),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    forward('error.rendererRejection', {
      message: (reason && reason.message) || String(reason),
      stack: stackOf(reason),
    });
  });

  forward('ui.logging', { installed: true });
}

/** The filename a report gets, stamped so two exports never collide. */
export function reportName(now = new Date()) {
  return `lucidafetcher-diagnostics-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`;
}

/**
 * Collect, summarise, render, save. Returns what the UI needs to say.
 *
 * `notes` is whatever the user typed about what they were doing - the one piece
 * of context no amount of logging can recover, and the first thing anyone
 * reading the report wants to know.
 */
export async function exportDiagnostics(ipc, { notes = null, includePrevious = 0 } = {}) {
  const bundle = await ipc.invoke('diagnostics-collect', { includePrevious });
  const summary = summarize(bundle.events || []);

  let text = renderReport({
    summary,
    config: bundle.config,
    raw: bundle.raw || [],
    notes,
  });

  // The IPC census is the main process's own measurement, so it is appended
  // here rather than derived from the events - a handler that failed silently
  // shows up as a count even when nothing else recorded it.
  if (bundle.ipc && bundle.ipc.length) {
    text += '\n## IPC calls\n\n| channel | calls | failures | slowest |\n|---|---|---|---|\n'
      + bundle.ipc.map((c) => `| ${c.channel} | ${c.n} | ${c.fails} | ${c.slowest}ms |`).join('\n')
      + '\n';
  }
  text += `\n---\n\nRaw session log: \`${bundle.logFile}\`\n`;

  const saved = await ipc.invoke('diagnostics-save', { name: reportName(), text });
  return { ...saved, summary, bytes: text.length, events: (bundle.events || []).length };
}
