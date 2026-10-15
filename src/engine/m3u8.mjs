// Pure M3U8 playlist generator.
//
// Formats an extended M3U (#EXTM3U) playlist using relative paths with forward
// slashes, compatible across Windows, macOS, Linux, and mobile players (VLC,
// Foobar2000, MusicBee, Plex, etc.).

import path from 'node:path';

/**
 * Format an M3U8 string for a playlist.
 *
 * @param {object} playlist - { name, file, trackKeys: string[] }
 * @param {Map|object} tracks - Map or object of trackKey -> track metadata
 * @param {object} [opts] - { playlistDir: 'Playlists', onlyDownloaded: true }
 * @returns {string}
 */
export function formatM3U8(playlist, tracks, opts = {}) {
  const onlyDownloaded = opts.onlyDownloaded !== false;
  const playlistRelDir = opts.playlistDir || 'Playlists';
  const getTrack = (key) => (tracks instanceof Map ? tracks.get(key) : tracks[key]);

  const lines = ['#EXTM3U'];

  for (const key of playlist.trackKeys || []) {
    const t = getTrack(key);
    if (!t) continue;
    if (onlyDownloaded && t.status !== 'downloaded' && t.status !== 'completed') continue;

    const duration = Math.round(Number(t.durationSec) || -1);
    const artist = t.artist || 'Unknown Artist';
    const title = t.title || 'Unknown Title';
    lines.push(`#EXTINF:${duration},${artist} - ${title}`);

    // Track file is relative to profile root (e.g. "Tracks/Queen - Bohemian Rhapsody.flac")
    const trackFile = String(t.file || '').replace(/\\/g, '/');
    let relPath = trackFile;
    if (playlistRelDir && !trackFile.startsWith('../')) {
      relPath = path.posix.relative(playlistRelDir, trackFile);
    }
    lines.push(relPath.replace(/\\/g, '/'));
  }

  return lines.join('\n') + '\n';
}
