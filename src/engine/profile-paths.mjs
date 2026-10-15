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

export function playlistFileName(name, id) {
  return `Playlists/${clean(name)} [${suffix(id)}].m3u8`;
}

export function assignPlaylistFiles(playlists = []) {
  const proposed = playlists.map(pl => pl.file
    ? `Playlists/${clean(String(pl.file).replace(/\\/g, '/').split('/').pop().replace(/\.m3u8$/i, ''))}.m3u8`
    : playlistFileName(pl.name, pl.id));
  const counts = new Map();
  for (const name of proposed) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) || 0) + 1);
  const used = new Set();
  return playlists.map((pl, i) => {
    let file = counts.get(proposed[i].toLowerCase()) > 1 ? playlistFileName(pl.name, pl.id) : proposed[i];
    const base = file.slice(0, -5);
    for (let n = 1; used.has(file.toLowerCase()); n++) file = `${base} (${n}).m3u8`;
    used.add(file.toLowerCase());
    return { ...pl, file };
  });
}
