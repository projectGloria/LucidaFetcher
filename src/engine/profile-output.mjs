// Complete profile output is serialized by main, including shared file copies.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadLibrary, saveLibrary } from './library.mjs';
import { formatM3U8 } from './m3u8.mjs';
import { assignPlaylistFiles } from './profile-paths.mjs';

const downloaded = track => ['downloaded', 'completed'].includes(track.status);
const inside = (root, file) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
};
const relativeFile = (root, file) => path.relative(root, file).replace(/\\/g, '/');
const trackPath = (root, file) => {
  if (!file || path.isAbsolute(file)) return null;
  const target = path.resolve(root, String(file).replace(/\\/g, '/'));
  return inside(path.join(root, 'Tracks'), target) ? target : null;
};

export async function loadValidatedLibrary(profileDir, validateFile) {
  const state = await loadLibrary(profileDir);
  const tracks = Object.entries(state.tracks);
  for (let start = 0; start < tracks.length; start += 8) {
    const batch = await Promise.all(tracks.slice(start, start + 8).map(async ([key, original]) => {
      const track = { ...original };
      const target = trackPath(profileDir, track.file);
      delete track.savePath;
      if (!downloaded(track)) return [key, track];
      if (target && track.bytes > 0 && await validateFile(target, track.bytes, track)) return [key, { ...track, savePath: target }];
      return [key, { ...track, status: 'missing', file: null, bytes: null }];
    }));
    for (const [key, track] of batch) state.tracks[key] = track;
  }
  state.playlists = assignPlaylistFiles(state.playlists);
  return state;
}

export async function syncProfileLibrary(profileDir, snapshot, { validateFile, sourceFolder, reserveCopy = () => () => {}, saveArtwork = () => {} }) {
  const state = structuredClone(snapshot);
  const previous = await loadValidatedLibrary(profileDir, validateFile);
  state.playlists = assignPlaylistFiles(state.playlists);
  const claimed = new Map();
  for (const [key, track] of Object.entries(previous.tracks)) {
    if (track.savePath) claimed.set(track.savePath.toLowerCase(), key);
  }
  await fs.mkdir(path.join(profileDir, 'Tracks'), { recursive: true });
  for (const [key, track] of Object.entries(state.tracks || {})) {
    let source = track.savePath;
    if (!source && track.sourceFolder && sourceFolder) source = trackPath(sourceFolder(track.sourceFolder), track.file);
    if (!source) source = trackPath(profileDir, track.file);
    delete track.savePath;
    delete track.sourceFolder;
    if (!downloaded(track)) continue;
    if (!source || !(track.bytes > 0) || !await validateFile(source, track.bytes)) {
      track.status = 'missing'; track.file = null; track.bytes = null;
      continue;
    }
    let target = source;
    if (!inside(path.join(profileDir, 'Tracks'), source)) {
      const old = previous.tracks[key];
      target = old?.savePath && old.bytes === track.bytes ? old.savePath : null;
      if (!target) {
        const name = path.basename(source);
        const base = name.replace(/\.flac$/i, '').slice(0, 160);
        const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);
        for (let n = 0; ; n++) {
          target = path.join(profileDir, 'Tracks', n ? `${base} [${hash}]${n > 1 ? ` (${n})` : ''}.flac` : name);
          const release = reserveCopy(target);
          if (!release) continue; // a live Chromium transfer owns this path
          try {
            // COPYFILE_EXCL never replaces the user's music or another track.
            await fs.copyFile(source, target, 1);
            break;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          } finally { release(); }
        }
      }
    }
    if (claimed.has(target.toLowerCase()) && claimed.get(target.toLowerCase()) !== key) {
      track.status = 'missing'; track.file = null; track.bytes = null;
      continue;
    }
    claimed.set(target.toLowerCase(), key);
    track.file = relativeFile(profileDir, target);
  }
  await saveLibrary(profileDir, state);
  await fs.mkdir(path.join(profileDir, 'Playlists'), { recursive: true });
  if (state.profile?.image) saveArtwork(state.profile.image, path.join(profileDir, 'cover.jpg'));
  for (const playlist of state.playlists) {
    const target = path.join(profileDir, playlist.file);
    if (playlist.artwork) saveArtwork(playlist.artwork, target.replace(/\.m3u8$/i, '.jpg'));
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, formatM3U8(playlist, state.tracks));
      await fs.rename(tmp, target);
    } finally { await fs.unlink(tmp).catch(() => {}); }
  }
  return state;
}
