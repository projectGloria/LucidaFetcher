// Library manifest management for profile downloads.
//
// Maintains `library.json` in the profile root as the single source of truth:
// - All paths stored are relative to the profile directory.
// - Atomic writes via .tmp + rename prevent corruption on sudden app kills.
// - Corrupt JSON files are backed up to .corrupt-<timestamp> rather than crashing.
// - Collision-safe track filename generator appends a deterministic hash suffix
//   when two distinct track keys map to identical sanitized filenames.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeTrackFileName(artist, title, key = '', claimedFiles = new Set()) {
  const cleanPart = (s) =>
    String(s || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '')
      .trim()
      .replace(/[. ]+$/g, '');

  let a = cleanPart(artist) || 'Unknown Artist';
  let t = cleanPart(title) || 'Unknown Title';
  if (RESERVED.test(a)) a = `${a}_`;
  if (RESERVED.test(t)) t = `${t}_`;

  let base = `${a} - ${t}`.slice(0, 160).trim();
  if (!base) base = 'Track';

  let candidate = `${base}.flac`;
  if (claimedFiles && claimedFiles.has(candidate)) {
    const hash = crypto.createHash('sha1').update(String(key || `${a}|${t}`)).digest('hex').slice(0, 6);
    candidate = `${base} [${hash}].flac`;
  }
  return candidate;
}

const writeQueues = new Map();

function queueWrite(file, task) {
  const current = writeQueues.get(file) || Promise.resolve();
  const next = current.then(task, task);
  writeQueues.set(file, next);
  return next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  });
}

export async function loadLibrary(profileDir) {
  const libFile = path.join(profileDir, 'library.json');
  try {
    const raw = await fs.promises.readFile(libFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid library object');
    return {
      version: parsed.version || 1,
      profile: parsed.profile || {},
      tracks: parsed.tracks || {},
      playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { version: 1, profile: {}, tracks: {}, playlists: [] };
    }
    // Corrupt JSON: rename and recover
    const corruptPath = `${libFile}.corrupt-${Date.now()}`;
    try { await fs.promises.rename(libFile, corruptPath); } catch {}
    return { version: 1, profile: {}, tracks: {}, playlists: [] };
  }
}

export function saveLibrary(profileDir, state) {
  const libFile = path.join(profileDir, 'library.json');
  const data = JSON.stringify(state, null, 2);

  return queueWrite(libFile, async () => {
    const tmp = `${libFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.promises.mkdir(profileDir, { recursive: true });
      await fs.promises.writeFile(tmp, data, 'utf8');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await fs.promises.rename(tmp, libFile);
          return;
        } catch (e) {
          if (attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
      }
    } finally {
      try { await fs.promises.unlink(tmp); } catch {}
    }
  });
}
