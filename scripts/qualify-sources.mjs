import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { scrapePublicCatalog, parseCatalogHtml } from '../src/engine/public-catalog.mjs';
import { API_PROVIDERS, providerRequestUrl } from '../src/engine/providers.mjs';

const results = { date: '2026-10-28', providers: [], imports: [] };
for (const [id, descriptor] of Object.entries(API_PROVIDERS)) {
  try {
    const response = await fetch(providerRequestUrl(id, 'search', { query: 'Daft Punk' }), { redirect: 'error', signal: AbortSignal.timeout(10000) });
    results.providers.push({ id, host: new URL(descriptor.baseUrl).host, searchStatus: response.status,
      qualified: false, reason: 'Search availability alone does not qualify a lossless download provider.' });
    await response.body?.cancel();
  } catch (error) { results.providers.push({ id, qualified: false, reason: error.cause?.code || error.name }); }
}
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucida-qualification-'));
const refs = [
  { service: 'tidal', type: 'track', id: '48717877', url: 'https://tidal.com/browse/track/48717877' },
  { service: 'tidal', type: 'album', id: '48717868', url: 'https://tidal.com/album/48717868' },
  { service: 'tidal', type: 'playlist', id: 'c989958b-c60a-4bdc-b58f-25236c6c1e8a', url: 'https://tidal.com/playlist/c989958b-c60a-4bdc-b58f-25236c6c1e8a' },
  { service: 'qobuz', type: 'album', id: '0886443927087', url: 'https://www.qobuz.com/us-en/album/random-access-memories-daft-punk/0886443927087' },
  { service: 'qobuz', type: 'track', id: '416410122', url: 'https://play.qobuz.com/track/416410122' },
  { service: 'qobuz', type: 'playlist', id: '2340494', url: 'https://www.qobuz.com/gb-en/playlists/qobuz-top-50/2340494' },
];
await fs.writeFile(path.join(directory, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const results = [];
  const { createCatalogTransport } = await import(${JSON.stringify(new URL('../src/engine/catalog-http.mjs', import.meta.url).href)});
  const read = createCatalogTransport({ fetch: globalThis.fetch, readText: async (response, _host, limit) => {
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > limit) throw new Error('Response too large'); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks).toString('utf8');
  } });
  for (const ref of ${JSON.stringify(refs)}) {
    const win = new BrowserWindow({ show: false, webPreferences: { partition: 'qualification', backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } });
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    let timer;
    try {
      await win.loadURL('about:blank');
      const response = await Promise.race([read(ref.url), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Page timed out')), 45000); })]);
      const data = response.page || await win.webContents.executeJavaScript('(() => { const scrapePublicCatalog = ' + ${JSON.stringify(scrapePublicCatalog.toString())}
        + '; return (' + ${JSON.stringify(parseCatalogHtml.toString())} + ')(' + JSON.stringify(response.html) + ',' + JSON.stringify(ref) + '); })()');
      results.push({ service: ref.service, type: ref.type, url: ref.url, tracks: data.tracks.length, complete: data.complete,
        name: data.name, withArtwork: data.tracks.filter(t => t.image).length, withDuration: data.tracks.filter(t => t.durationSec > 0).length });
    } catch (error) { results.push({ service: ref.service, type: ref.type, error: error.message }); }
    finally { clearTimeout(timer); win.destroy(); }
  }
  console.log('QUALIFICATION:' + JSON.stringify(results)); app.exit(0);
});
app.on('window-all-closed', () => {});
setTimeout(() => app.exit(1), 150000);
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const require = createRequire(import.meta.url);
const output = await new Promise((resolve, reject) => {
  const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { windowsHide: true, env });
  let text = ''; child.stdout.on('data', bytes => { text += bytes; }); child.stderr.on('data', bytes => { text += bytes; });
  child.on('error', reject); child.on('exit', code => code ? reject(new Error('Qualification process failed')) : resolve(text));
});
const line = output.split(/\r?\n/).find(value => value.startsWith('QUALIFICATION:'));
results.imports = JSON.parse(line.slice(14));
await fs.mkdir('review', { recursive: true });
await fs.writeFile('review/provider-qualification-2026-10-28.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('lucida-qualification-')) throw new Error('Unexpected qualification directory');
await fs.rm(directory, { recursive: true, force: true });
