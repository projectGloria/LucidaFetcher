import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpotifyMetadata, parseSpotifyEmbed } from '../src/engine/spotify-metadata.mjs';
import { refreshSpotifyArtwork } from '../src/engine/spotify-artwork.mjs';
import { Controller } from '../src/engine/controller.mjs';

const url = id => `https://open.spotify.com/playlist/${id}`;
const embed = (name = 'Mix') => `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { name, trackList: [{ title: 'Song' }] } } } } } })}</script>`;
const success = name => ({ ok: true, status: 200, text: async () => embed(name) });
const fakeClock = () => {
  let time = 100000;
  return { now: () => time, sleep: async ms => { time += ms; }, advance: ms => { time += ms; } };
};

test('embed parsing accepts attribute order changes and single-quoted ids', () => {
  assert.equal(parseSpotifyEmbed(embed()).props.pageProps.state.data.entity.name, 'Mix');
  assert.equal(parseSpotifyEmbed(embed().replace('id="__NEXT_DATA__"', "id='__NEXT_DATA__'")).props.pageProps.state.data.entity.name, 'Mix');
});

test('playlist and artwork requests share pacing and a two-request concurrency cap', async () => {
  const clock = fakeClock();
  const starts = [];
  let active = 0, peak = 0;
  const read = createSpotifyMetadata({ ...clock, fetch: async () => {
    starts.push(clock.now());
    active++; peak = Math.max(peak, active);
    await new Promise(done => setTimeout(done, 2));
    active--;
    return success();
  } });
  await Promise.all(Array.from({ length: 12 }, (_, i) => read(`https://open.spotify.com/${i % 2 ? 'track' : 'playlist'}/${i}`)));
  assert.ok(peak <= 2);
  assert.equal(starts.length, 12);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 500);
});

test('successful metadata is shared, persists across clients and expires for playlist refreshes', async () => {
  const clock = fakeClock();
  const stored = new Map();
  const cache = { get: key => stored.get(key), set: (key, value) => stored.set(key, value) };
  let calls = 0;
  const config = { ...clock, cache, fetch: async () => { calls++; return success('Read ' + calls); } };
  const read = createSpotifyMetadata(config);
  const [a, b] = await Promise.all([read(url('a')), read(url('a'))]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  const nextClient = createSpotifyMetadata(config);
  assert.equal((await nextClient(url('a'))).props.pageProps.state.data.entity.name, 'Read 1');
  assert.equal(calls, 1);
  clock.advance(10 * 60 * 1000);
  assert.equal((await nextClient(url('a'))).props.pageProps.state.data.entity.name, 'Read 2');
  assert.equal(calls, 2);
});

test('HTTP 429 honors Retry-After before retrying and does not cache the failure', async () => {
  const clock = fakeClock();
  const starts = [];
  let cancelled = 0;
  const read = createSpotifyMetadata({ ...clock, fetch: async () => {
    starts.push(clock.now());
    return starts.length === 1 ? { ok: false, status: 429, headers: { get: () => '2' }, body: { cancel: () => { cancelled++; } } } : success();
  } });
  const data = await read(url('a'));
  assert.equal(data.props.pageProps.state.data.entity.name, 'Mix');
  assert.equal(starts[1] - starts[0], 2000);
  assert.equal(cancelled, 1);
  await read(url('a'));
  assert.equal(starts.length, 2);
});

test('an exhausted rate-limit cooldown prevents a failed request burst while cached playlists still work', async () => {
  const clock = fakeClock();
  let calls = 0;
  const read = createSpotifyMetadata({ ...clock, fetch: async value => {
    calls++;
    return value.endsWith('/good') ? success() : { status: 429, headers: { get: () => '2' } };
  } });
  await read(url('good'));
  await assert.rejects(read(url('limited')), /temporarily limiting/);
  assert.equal(calls, 4);
  await assert.rejects(read(url('another')), /temporarily limiting/);
  await read(url('good'));
  assert.equal(calls, 4);
  clock.advance(3000);
  await read(url('good'));
  assert.equal(calls, 4);
});

test('404 and empty playlists are not retried as rate limits', async () => {
  let calls = 0;
  const read = createSpotifyMetadata({ fetch: async () => { calls++; return { status: 404 }; } });
  assert.equal(await read(url('deleted')), null);
  assert.equal(calls, 1);
});

test('a late artwork response cannot recreate a removed playlist or track', async () => {
  const c = new Controller();
  c.pause();
  let finish;
  try {
    c.addProfile({ id: 'u' }, [{ id: 'p', artwork: 'playlist.jpg', trackKeys: ['song'] }], {
      song: { title: 'Song', artist: 'Artist', service: 'spotify', trackId: 'song', image: 'playlist.jpg', artworkPending: true },
    });
    const refresh = refreshSpotifyArtwork(c, { spotifyTrackArtwork: () => new Promise(done => { finish = done; }) });
    c.removeGroup('p');
    finish('album.jpg');
    await refresh;
    assert.equal(c.getItems().length, 0);
    assert.equal(c.tracks.size, 0);
  } finally { c.dispose(); }
});
