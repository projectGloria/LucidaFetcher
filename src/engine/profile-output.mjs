// Complete profile output is serialized by main, including shared file copies.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadLibrary } from './library.mjs';
import { assignPlaylistFiles } from './profile-paths.mjs';

const memoryLibraries = new Map();
const dirKey = profileDir => {
  const resolved = path.resolve(String(profileDir || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const downloaded = track => ['downloaded', 'completed'].includes(track.status);
const inside = (root, file) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
};
const relativeFile = (root, file) => path.relative(root, file).replace(/\\/g, '/');
const trackPath = (root, file) => {
  if (!file || path.isAbsolute(file)) return null;
  const target = path.resolve(root, String(file).replace(/\\/g, '/'));
  return inside(root, target) ? target : null;
};

export async function loadValidatedLibrary(profileDir, validateFile) {
  const disk = await loadLibrary(profileDir);
  const mem = memoryLibraries.get(dirKey(profileDir));
  const state = mem ? structuredClone(mem) : disk;
  if (mem && disk?.tracks && Object.keys(disk.tracks).length) {
    state.tracks = { ...state.tracks, ...disk.tracks };
  }
  const tracks = Object.entries(state.tracks);
  for (let start = 0; start < tracks.length; start += 8) {
    const batch = await Promise.all(tracks.slice(start, start + 8).map(async ([key, original]) => {
      const track = { ...original };
      const target = trackPath(profileDir, track.file);
      delete track.savePath;
      if (!downloaded(track)) return [key, track];
      const extraTargets = track.playlistFiles
        ? Object.values(track.playlistFiles).map(rel => trackPath(profileDir, rel))
        : [];
      const allTargets = [target, ...extraTargets];
      let valid = Boolean(target && track.bytes > 0 && allTargets.every(Boolean));
      if (valid) {
        const checks = await Promise.all(allTargets.map(t => validateFile(t, track.bytes, track)));
        valid = checks.every(Boolean);
      }
      if (valid) return [key, { ...track, savePath: target }];
      const failed = { ...track, status: 'missing', file: null, bytes: null };
      delete failed.playlistFiles;
      return [key, failed];
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
    for (const rel of Object.values(track.playlistFiles || {})) {
      const full = trackPath(profileDir, rel);
      if (full) claimed.set(full.toLowerCase(), key);
    }
  }

  const playlistsForKey = new Map();
  for (const playlist of state.playlists) {
    const plFolder = playlist.folder || playlist.file;
    const plDir = path.join(profileDir, plFolder);
    await fs.mkdir(plDir, { recursive: true });
    const artUrl = playlist.artwork || state.profile?.image;
    if (artUrl) saveArtwork(artUrl, path.join(plDir, 'cover.png'));
    for (const key of playlist.trackKeys || []) {
      let list = playlistsForKey.get(key);
      if (!list) { list = []; playlistsForKey.set(key, list); }
      if (!list.some(p => (p.folder || p.file) === plFolder)) list.push(playlist);
    }
  }

  for (const [key, track] of Object.entries(state.tracks || {})) {
    const memberPlaylists = playlistsForKey.get(key) || [];
    const candidates = [];
    if (track.savePath) candidates.push(track.savePath);
    if (track.sourceFolder && sourceFolder) {
      const srcRoot = sourceFolder(track.sourceFolder);
      const fromSrc = trackPath(srcRoot, track.file);
      if (fromSrc) candidates.push(fromSrc);
    }
    const direct = trackPath(profileDir, track.file);
    if (direct) candidates.push(direct);
    if (track.file) {
      const base = path.basename(String(track.file).replace(/\\/g, '/'));
      for (const pl of memberPlaylists) {
        const inPl = trackPath(profileDir, `${pl.folder || pl.file}/${base}`);
        if (inPl) candidates.push(inPl);
      }
    }
    if (previous.tracks[key]?.savePath) candidates.push(previous.tracks[key].savePath);

    delete track.savePath;
    delete track.sourceFolder;
    if (!downloaded(track)) continue;

    let source = null;
    if (track.bytes > 0) {
      for (const candidate of candidates) {
        if (candidate && await validateFile(candidate, track.bytes, track)) {
          source = candidate;
          break;
        }
      }
    }
    if (!source) {
      track.status = 'missing'; track.file = null; track.bytes = null;
      delete track.playlistFiles;
      continue;
    }

    const targetFolders = memberPlaylists.length
      ? memberPlaylists.map(pl => pl.folder || pl.file)
      : [state.playlists[0]?.folder || state.playlists[0]?.file || 'Playlist'];

    const playlistFiles = {};
    let firstTarget = null;
    for (const plFolder of targetFolders) {
      const plDir = path.join(profileDir, plFolder);
      await fs.mkdir(plDir, { recursive: true });
      let target = null;
      if (inside(plDir, source)) {
        target = source;
      } else {
        const old = previous.tracks[key];
        const oldRel = old?.playlistFiles?.[plFolder] || (old?.file && inside(plDir, trackPath(profileDir, old.file) || '') ? old.file : null);
        const oldPath = oldRel ? trackPath(profileDir, oldRel) : null;
        if (oldPath && old.bytes === track.bytes && await validateFile(oldPath, track.bytes, track)) {
          target = oldPath;
        } else {
          const name = path.basename(source);
          const base = name.replace(/\.flac$/i, '').slice(0, 160);
          const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);
          for (let n = 0; ; n++) {
            target = path.join(plDir, n ? `${base} [${hash}]${n > 1 ? ` (${n})` : ''}.flac` : name);
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
        delete track.playlistFiles;
        firstTarget = null;
        break;
      }
      claimed.set(target.toLowerCase(), key);
      playlistFiles[plFolder] = relativeFile(profileDir, target);
      if (!firstTarget) firstTarget = target;
    }
    if (firstTarget) {
      track.file = relativeFile(profileDir, firstTarget);
      track.playlistFiles = playlistFiles;
    }
  }
  memoryLibraries.set(dirKey(profileDir), structuredClone(state));
  return state;
}
