import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
function helper(rows) {
  const api = { exec() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit('data', rows.map(r => JSON.stringify(r)).join('\n'));
      proc.emit('close', 0);
    });
    return proc;
  } };
  const sandbox = { module: { exports: {} }, require: name => name === 'youtube-dl-exec' ? api : require(name), console, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync(new URL('../youtube-dl.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.module.exports;
}

test('SoundCloud metadata retains the webpage URL instead of the raw audio URL', async () => {
  const result = await helper([{ title: 'Artist - Song', id: '123', url: 'https://cdn.example/audio.mp3', webpage_url: 'https://soundcloud.com/artist/song' }])
    .resolveMediaUrl('https://snd.sc/short');
  assert.equal(result.entries[0].url, 'https://soundcloud.com/artist/song');
});

test('a SoundCloud set with one track remains a playlist', async () => {
  const result = await helper([{ title: 'Song', playlist_title: 'My Set', playlist_id: '123', url: 'https://soundcloud.com/artist/song' }])
    .resolveMediaUrl('https://soundcloud.com/artist/sets/my-set');
  assert.equal(result.kind, 'playlist');
  assert.equal(result.title, 'My Set');
});
