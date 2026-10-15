import { mapPool } from './sources.mjs';

// Refresh covers after the track list is queued. A removed or replaced record
// must never be recreated by a late response from Spotify.
export async function refreshSpotifyArtwork(controller, sources) {
  const covers = new Set([...controller.playlists.values()].map(p => p.artwork).filter(Boolean));
  const records = [...controller.tracks.values(), ...controller.items.values()];
  const pending = records.filter(({ item }) => (item.service === 'spotify' || item.originalService === 'spotify') && item.trackId
    && (item.artworkPending || !item.image || covers.has(item.image)));
  for (let at = 0; at < pending.length && !controller._disposed; at += 8) {
    const updates = await mapPool(pending.slice(at, at + 8), 2, async ({ item }) => {
      if (controller._disposed || controller.getItem(item.id)?.item !== item) return null;
      try {
        const image = await sources.spotifyTrackArtwork(item.trackId);
        return image ? { id: item.id, item, image } : null;
      } catch { return null; }
    });
    controller.updateArtwork(updates.filter(Boolean));
  }
}
