// Browser-safe playlist naming, shared by imports, persistence and disk output.
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const clean = value => {
  let name = String(value || 'Playlist').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '').trim().slice(0, 140) || 'Playlist';
  if (reserved.test(name)) name = '_' + name;
  return name;
};
const suffix = id => {
  let hash = 2166136261;
  for (const char of String(id)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const stripPlaylistPath = value => clean(
  String(value || '').replace(/\\/g, '/').replace(/^Playlists\/+/i, '').split('/').pop().replace(/\.m3u8$/i, '')
);

export function playlistFileName(name, id) {
  return `${clean(name)} [${suffix(id)}]`;
}

export function assignPlaylistFiles(playlists = []) {
  const proposed = playlists.map(pl => {
    const raw = pl.folder || pl.file;
    return raw ? stripPlaylistPath(raw) : clean(pl.name);
  });
  const counts = new Map();
  for (const name of proposed) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) || 0) + 1);
  const used = new Set();
  return playlists.map((pl, i) => {
    let folder = counts.get(proposed[i].toLowerCase()) > 1 ? playlistFileName(pl.name || proposed[i], pl.id) : proposed[i];
    const base = folder;
    for (let n = 1; used.has(folder.toLowerCase()); n++) folder = `${base} (${n})`;
    used.add(folder.toLowerCase());
    return { ...pl, folder, file: folder };
  });
}
