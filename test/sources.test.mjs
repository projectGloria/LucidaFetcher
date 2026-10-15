import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput, parseProfileInput, sanitizeFolder, createSources, mapPool, largestImage } from '../src/engine/sources.mjs';

test('recognises Spotify and Deezer playlist links', () => {
  assert.deepEqual(
    classifyInput('https://open.spotify.com/playlist/37i9dQZF1DX?si=abc'),
    { kind: 'spotify-playlist', id: '37i9dQZF1DX', url: 'https://open.spotify.com/playlist/37i9dQZF1DX', type: 'playlist' }
  );
  assert.deepEqual(
    classifyInput('https://open.spotify.com/intl-de/playlist/37i9dQZF1DX?si=abc'),
    { kind: 'spotify-playlist', id: '37i9dQZF1DX', url: 'https://open.spotify.com/intl-de/playlist/37i9dQZF1DX', type: 'playlist' }
  );
  assert.equal(classifyInput('https://www.deezer.com/en/playlist/908622995').kind, 'deezer-playlist');
  assert.equal(classifyInput('https://www.deezer.com/album/12345').type, 'album');
});

test('treats bare text as a track query, not a profile', () => {
  // A bare name has to stay a search; only the explicit prefix means a profile.
  assert.deepEqual(classifyInput('Obzkure Fetish'), { kind: 'text', text: 'Obzkure Fetish' });
  assert.equal(classifyInput('user:thesimulacrum').kind, 'profile');
});

test('an explicit service token overrides the default profile service', () => {
  assert.deepEqual(parseProfileInput('user:deezer:someone', 'spotify'), { service: 'deezer', user: 'someone' });
  assert.equal(parseProfileInput('user:'), null);
});

test('reads a profile out of a full profile URL', () => {
  assert.deepEqual(parseProfileInput('https://open.spotify.com/user/abc123'), { service: 'spotify', user: 'abc123' });
  assert.deepEqual(parseProfileInput('https://open.spotify.com/intl-fr/user/abc123'), { service: 'spotify', user: 'abc123' });
  assert.deepEqual(parseProfileInput('https://www.deezer.com/en/profile/55'), { service: 'deezer', user: '55' });
});

test('an unrelated link is refused rather than guessed at', () => {
  assert.equal(parseProfileInput('https://example.com/x'), null);
  assert.equal(classifyInput('https://example.com/x').kind, 'link');
});

test('strips characters a folder name cannot contain', () => {
  assert.equal(sanitizeFolder('AC/DC: Best of <2024>'), 'ACDC Best of 2024');
  assert.equal(sanitizeFolder('///'), 'Playlist', 'never returns an empty name');
  assert.equal(sanitizeFolder('AUX.txt'), 'AUX_.txt', 'DOS device names remain reserved with extensions');
  assert.equal(sanitizeFolder('Album... '), 'Album');
  assert.equal(sanitizeFolder('Album\u0000'), 'Album');
});

const embed = (entity) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;

test('turns a Spotify playlist into queueable tracks', async () => {
  const html = embed({
    name: 'KAN',
    coverArt: { sources: [{ url: 'small.jpg', width: 64 }, { url: 'big.jpg', width: 640 }] },
    trackList: [
      { uri: 'spotify:track:1', title: 'Fetish', subtitle: 'Obzkure' },
      { uri: 'spotify:track:2', title: 'Carnage', subtitle: 'WIB3X' },
    ],
  });
  const sources = createSources({ fetch: async () => ({ text: async () => html }) });
  const out = await sources.spotifyPlaylist('https://open.spotify.com/playlist/x');

  assert.equal(out.name, 'KAN');
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results[0].texts, ['Fetish', 'Obzkure']);
  assert.equal(out.group.folderName, 'KAN');
  // Largest cover wins, not merely the first listed.
  assert.equal(out.group.artworkUrl, 'big.jpg');
  assert.match(out.results[0].link, /lucida\.to\/search\?query=Fetish%20Obzkure/);
});

test('reports a Spotify link it cannot parse instead of throwing', async () => {
  const sources = createSources({ fetch: async () => ({ text: async () => '<html>nope</html>' }) });
  const out = await sources.spotifyPlaylist('https://open.spotify.com/playlist/x');
  assert.match(out.error, /without playlist metadata/);
});

test('Spotify profile playlists get distinct track covers with shared globally bounded requests', async () => {
  let active = 0, peak = 0;
  const calls = new Map();
  const sources = createSources({ fetch: async url => {
    if (url.includes('/embed/playlist/')) return { text: async () => embed({ name: 'Mix', coverArt: { sources: [{ url: 'playlist.jpg' }] },
      trackList: Array.from({ length: 12 }, (_, i) => ({ uri: `spotify:track:${i}`, title: `Song ${i}`, subtitle: 'Artist' })) }) };
    const id = url.split('/').pop();
    calls.set(id, (calls.get(id) || 0) + 1);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return { text: async () => embed({ coverArt: { sources: [{ url: `track-${id}.jpg`, width: 640 }] } }) };
  } });
  const [first, second] = await Promise.all(['a', 'b'].map(id => sources.spotifyPlaylist(`https://open.spotify.com/playlist/${id}`)));
  assert.equal(first.group.artworkUrl, 'playlist.jpg');
  assert.deepEqual(first.results.map(r => r.image), Array.from({ length: 12 }, (_, i) => `track-${i}.jpg`));
  assert.deepEqual(first.results.map(r => r.image), second.results.map(r => r.image));
  assert.equal(calls.size, 12);
  assert.ok([...calls.values()].every(n => n === 1));
  assert.ok(peak <= 8);
});

test('failed Spotify artwork requests can be repaired on reimport', async () => {
  let fail = true;
  const sources = createSources({ fetch: async () => {
    if (fail) throw new Error('temporary failure');
    return { text: async () => embed({ visualIdentity: { image: [{ url: 'album.jpg', maxWidth: 640 }] } }) };
  } });
  assert.equal(await sources.spotifyTrackArtwork('id'), '');
  fail = false;
  assert.equal(await sources.spotifyTrackArtwork('id'), 'album.jpg');
});

test('a Spotify playlists page without an avatar reads the main profile header', async () => {
  const urls = [];
  const sources = createSources({ scraper: { run: async url => {
    urls.push(url);
    return url.endsWith('/playlists')
      ? { outcome: 'ok', profile: { name: 'User', image: '' }, items: [{ id: 'p', name: 'Mix', image: 'playlist.jpg' }] }
      : { name: 'User', image: 'avatar.jpg' };
  } } });
  const result = await sources.spotifyProfilePlaylists('user');
  assert.equal(result.profile.image, 'avatar.jpg');
  assert.equal(result.playlists[0].image, 'playlist.jpg');
  assert.deepEqual(urls, ['https://open.spotify.com/user/user/playlists', 'https://open.spotify.com/user/user']);
});

test('follows Deezer pagination rather than guessing a limit', async () => {
  const pages = {
    'https://api.deezer.com/playlist/9': { title: 'Mix', picture_xl: 'c.jpg' },
    'https://api.deezer.com/playlist/9/tracks?limit=200': {
      data: [{ title: 'A', artist: { name: 'X' } }], next: 'page2',
    },
    page2: { data: [{ title: 'B', artist: { name: 'Y' } }] },
  };
  const sources = createSources({ httpJson: async (u) => pages[u] });
  const out = await sources.deezerPlaylist({ id: '9' });
  assert.equal(out.results.length, 2, 'both pages must be followed');
  assert.deepEqual(out.results[1].texts, ['B', 'Y']);
});

test('stops Deezer pagination when circular next links occur', async () => {
  const pages = {
    'https://api.deezer.com/playlist/9': { title: 'Looping', picture_xl: 'c.jpg' },
    'https://api.deezer.com/playlist/9/tracks?limit=200': {
      data: [{ title: 'A', artist: { name: 'X' } }], next: 'page2',
    },
    page2: { data: [{ title: 'B', artist: { name: 'Y' } }], next: 'page2' },
  };
  const sources = createSources({ httpJson: async (u) => pages[u] });
  const out = await sources.deezerPlaylist({ id: '9' });
  assert.equal(out.results.length, 2);
});

test('mapPool honours its concurrency cap', async () => {
  let live = 0, peak = 0;
  await mapPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 3));
    live--;
  });
  // Promise.all over a whole trackList would fire one request per track at once.
  assert.equal(peak, 3);
});

test('mapPool keeps results in input order', async () => {
  const out = await mapPool([5, 1, 3], 2, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n * 2;
  });
  assert.deepEqual(out, [10, 2, 6]);
});

test('a forced mode overrides the guess', () => {
  // The whole reason the dropdown exists: a bare word is a valid track query AND
  // a valid Spotify handle, and only the user knows which one was meant.
  assert.deepEqual(classifyInput('amelia', 'spotify-profile'),
    { kind: 'profile', service: 'spotify', user: 'amelia' });
  assert.deepEqual(classifyInput('amelia', 'tracks'), { kind: 'text', text: 'amelia' });
  // Forcing tracks must not let a pasted link sneak back in as a playlist.
  assert.deepEqual(classifyInput('https://open.spotify.com/playlist/abc', 'tracks').kind, 'text');
});

test('an unambiguous Deezer profile link beats the Spotify mode', () => {
  // Honouring the dropdown here would only produce a lookup that cannot work.
  assert.deepEqual(classifyInput('https://www.deezer.com/en/profile/55', 'spotify-profile'),
    { kind: 'profile', service: 'deezer', user: '55' });
});

test('Deezer tracks carry their own album art, not the playlist cover', async () => {
  const pages = {
    'https://api.deezer.com/playlist/9': { title: 'Mix', picture_xl: 'playlist.jpg' },
    'https://api.deezer.com/playlist/9/tracks?limit=200': {
      data: [
        { title: 'A', artist: { name: 'X' }, album: { cover_xl: 'a-xl.jpg', cover_big: 'a-big.jpg' } },
        { title: 'B', artist: { name: 'Y' }, album: { cover_big: 'b-big.jpg' } },
        { title: 'C', artist: { name: 'Z' } },
      ],
    },
  };
  const sources = createSources({ httpJson: async (u) => pages[u] });
  const out = await sources.deezerPlaylist({ id: '9' });
  assert.equal(out.results[0].image, 'a-xl.jpg', 'the largest cover the row offers');
  assert.equal(out.results[1].image, 'b-big.jpg');
  // A row with no album (an album's own tracklist) still needs a picture.
  assert.equal(out.results[2].image, 'playlist.jpg');
});

test('largestImage reads Spotify both ways of stating a size', () => {
  // A playlist cover says `width`; a track image says `maxWidth`. Reading only
  // `width` compared 0 against 0 and kept whatever came last - a 64px thumbnail.
  assert.equal(largestImage([{ url: 'a', width: 300 }, { url: 'b', width: 640 }]), 'b');
  assert.equal(
    largestImage([{ url: 'a', maxWidth: 300 }, { url: 'b', maxWidth: 64 }, { url: 'c', maxWidth: 640 }]),
    'c'
  );
  assert.equal(largestImage([]), '');
  assert.equal(largestImage(undefined), '');
});
test('preserves video IDs, playlist IDs and SoundCloud secret tokens', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=abc123&list=PL123',
    'https://soundcloud.com/artist/sets/album?secret_token=s-test',
    'https://on.soundcloud.com/example',
    'https://snd.sc/example',
  ]) assert.deepEqual(classifyInput(url), { kind: 'media-link', url });
});

test('refuses SoundCloud and YouTube media links', async () => {
  const url = 'https://soundcloud.com/artist/sets/album?secret_token=s-test';
  const source = createSources();
  const result = await source.resolve(url);
  assert.match(result.error, /disabled/i);
});
