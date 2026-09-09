// Past searches, profile lookups and pasted links.
//
// An external store rather than component state: the Add view writes it and the
// sidebar reads a count off it, and lifting it into App would make every keystroke
// in a search box re-render the whole shell. Same shape the engine uses, so it is
// read with useSyncExternalStore in both places.

import { isElectron, ipc } from './engine.js';

const MAX = 60;

let entries = [];
let version = 0;
const listeners = new Set();

function emit() {
  version++;
  for (const fn of listeners) fn();
}

// One entry per distinct query, so searching the same thing twice moves it up
// rather than filling the list.
function keyOf(entry) {
  return `${entry.kind}:${String(entry.label || '').trim().toLowerCase()}`;
}

function persist() {
  if (isElectron) ipc.send('history-save', entries);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshot() {
  return version;
}

export function list() {
  return entries;
}

export async function loadHistory() {
  if (!isElectron) return;
  try {
    const stored = await ipc.invoke('history-get');
    if (Array.isArray(stored)) { entries = stored; emit(); }
  } catch (e) { /* an empty history is a valid one */ }
}

let seq = 0;

export function remember(entry) {
  const full = { id: `h-${Date.now()}-${seq++}`, at: Date.now(), ...entry };
  entries = [full, ...entries.filter((e) => keyOf(e) !== keyOf(full))].slice(0, MAX);
  // Written on every change rather than on unmount: the app is closed by killing
  // the window, which no unmount handler survives.
  persist();
  emit();
}

export function forget(id) {
  entries = entries.filter((e) => e.id !== id);
  persist();
  emit();
}

export function clearHistory() {
  entries = [];
  if (isElectron) ipc.send('history-clear');
  emit();
}
