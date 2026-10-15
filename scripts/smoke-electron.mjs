// An isolated Electron integration check: real webviews, cascades, IPC and
// Chromium downloads against a local fixture. Never reads the user's queue.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidafetcher-smoke-'));
const require = createRequire(import.meta.url);
const electron = require('electron');
const packaged = process.argv.includes('--packaged');
const archiveArg = process.argv.indexOf('--archive');
const packageArchive = archiveArg >= 0 ? path.resolve(process.argv[archiveArg + 1]) : path.join(root, 'release/win-unpacked/resources/app.asar');
const stateRoot = path.join(sandbox, packaged ? 'userData' : '');

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, { windowsHide: true, env });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output || `Exit ${code}`)));
  });
}

try {
  if (packaged) await fs.copyFile(packageArchive, path.join(sandbox, 'app.asar'));
  else for (const name of ['main.js', 'dist', 'build', 'src/engine']) await fs.cp(path.join(root, name), path.join(sandbox, name), { recursive: true });
  await fs.mkdir(path.join(stateRoot, 'state'), { recursive: true });
  await fs.mkdir(path.join(sandbox, 'downloads'));
  await fs.writeFile(path.join(stateRoot, 'state', 'config.json'), JSON.stringify({
    downloadPath: path.join(sandbox, 'downloads'), concurrency: 1, fallbackServices: ['qobuz'], closeToTray: false,
  }));
  // ffmpeg is only needed for this optional integration check, never by the app.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-f', 'lavfi', '-i', 'color=c=black:s=32x32', '-t', '0.2', '-map', '0:a', '-map', '1:v',
    '-c:a', 'flac', '-c:v', 'png', '-disposition:v', 'attached_pic', path.join(sandbox, 'fixture.flac')]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(sandbox, 'fixture.flac'),
    '-map', '0', '-c', 'copy', '-metadata', 'title=Other (Remix)', '-metadata', 'artist=Fixture', path.join(sandbox, 'wrong.flac')]);
  await fs.writeFile(path.join(sandbox, 'artwork.rgb'), randomBytes(1200 * 1200 * 3));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '1200x1200',
    '-i', path.join(sandbox, 'artwork.rgb'), '-frames:v', '1', path.join(sandbox, 'large.png')]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(sandbox, 'fixture.flac'), '-i', path.join(sandbox, 'large.png'),
    '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', path.join(sandbox, 'large.flac')]);
  // A zero total-sample count is valid FLAC and occurs in streamed exports.
  const unknownCount = await fs.readFile(path.join(sandbox, 'large.flac'));
  unknownCount.writeBigUInt64BE(unknownCount.readBigUInt64BE(18) & ~0xfffffffffn, 18);
  await fs.writeFile(path.join(sandbox, 'large.flac'), unknownCount);
  const engineUrl = new URL('../src/engine/renderer-integration.mjs', import.meta.url).href;
  const renderer = `
    (async () => {
      const { startEngine } = await import(${JSON.stringify(engineUrl)});
      const ipc = window.require('electron').ipcRenderer;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const c = startEngine({ ipcRenderer: ipc, container, services: ['qobuz'], concurrency: 2, keepTrying: true });
      c.retryDelayMs = 100; c.retryMaxDelayMs = 200;
      let pausedTransfer = false;
      c.subscribe(() => {
        if (!pausedTransfer && c.getItems().some(rec => ['ready', 'downloading'].includes(rec.status))) {
          pausedTransfer = true;
          c.pause();
          setTimeout(() => c.resume(), 100);
        }
      });
      await Promise.all([...container.querySelectorAll('webview')].map(view => new Promise(resolve => {
        view.addEventListener('dom-ready', resolve, { once: true });
      })));
      c.add(['Retry', 'Other', 'Large'].map(title => ({ id: title, key: title, title, artist: 'Fixture', searchVariants: [title] })));
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(JSON.stringify(c.getItems()))); }, 20000);
        const off = c.subscribe(() => {
          if (c.stats.completed === 3) { clearTimeout(timer); off(); resolve(c.getItems().map(rec => rec.result)); }
        });
      });
      c.pause(); c.resume();
      const tracks = Object.fromEntries(result.slice(0, 2).map((done, i) => ['shared-' + i, {
        title: 'Profile Song ' + i, artist: 'Fixture', status: 'downloaded',
        file: done.file, savePath: done.savePath, bytes: done.bytes,
      }]));
      const lists = [0, 1].map(i => ({ id: 'owner-' + i, name: 'Mix', file: 'Playlists/Mix.m3u8', artwork: 'https://art.fixture/' + i, trackKeys: ['shared-' + i] }));
      c.addProfile({ id: 'owner', folderName: 'Owner' }, lists, tracks);
      c.addProfile({ id: 'second', folderName: 'Second' }, [{ id: 'second-list', name: 'Mix', artwork: 'https://art.fixture/second', trackKeys: ['shared-0', 'shared-1'] }], tracks);
      // Library sync is asynchronous; wait for validated files, then main checks
      // the actual M3U references and shared copies below.
      const until = Date.now() + 10000;
      while (true) {
        const a = await ipc.invoke('profile-library-load', 'Owner');
        const b = await ipc.invoke('profile-library-load', 'Second');
        if (Object.values(a.tracks).length === 2 && Object.values(b.tracks).length === 2 &&
            [...Object.values(a.tracks), ...Object.values(b.tracks)].every(t => t.status === 'downloaded' && t.savePath) &&
            [...a.playlists.map(pl => ['Owner', pl]), ...b.playlists.map(pl => ['Second', pl])].every(([folder, pl]) =>
              window.require('fs').existsSync(window.require('path').join(${JSON.stringify(path.join(sandbox, 'downloads'))}, folder, pl.file.replace(/\\.m3u8$/i, '.jpg'))))) break;
        if (Date.now() > until) throw new Error('Profile libraries never became valid: ' + JSON.stringify({ a, b }));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      c.dispose();
      return result;
    })()
  `;
  const bootstrap = `
    const { app, BrowserWindow, session, ipcMain, net, nativeImage } = require('electron');
    const fs = require('fs'); const path = require('path'); const http = require('http');
    const fetch = net.fetch.bind(net);
    const cover = nativeImage.createFromPath(path.join(__dirname, 'large.png')).resize({ width: 64, height: 64 }).toPNG();
    net.fetch = (url, opts) => String(url).startsWith('https://art.fixture/')
      ? Promise.resolve(new Response(cover, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(cover.length) } }))
      : fetch(url, opts);
    app.setPath('userData', path.join(__dirname, 'userData'));
    if (${packaged}) {
      Object.defineProperty(app, 'isPackaged', { value: true });
      app.getAppPath = () => path.join(__dirname, 'app.asar');
    }
    app.on('browser-window-created', (_event, win) => { win.show = () => {}; });
    const fixture = fs.readFileSync(path.join(__dirname, 'fixture.flac'));
    const large = fs.readFileSync(path.join(__dirname, 'large.flac'));
    const audio = data => {
      let at = 4, last = false;
      while (!last) { last = !!(data[at] & 0x80); at += 4 + data.readUIntBE(at + 1, 3); }
      return data.subarray(at);
    };
    const visits = new Map();
    const activeDownloads = new Set();
    let sawPaused = false, sawResumed = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/wrong.flac') {
        const wrong = fs.readFileSync(path.join(__dirname, 'wrong.flac'));
        res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Disposition': 'attachment; filename="wrong.flac"', 'Content-Length': wrong.length });
        res.end(wrong); return;
      }
      if (url.pathname === '/large.flac') {
        res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Disposition': 'attachment; filename="large.flac"', 'Content-Length': large.length });
        res.end(large); return;
      }
      if (url.pathname === '/fixture.flac') {
        res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Disposition': 'attachment; filename="song.flac"', 'Content-Length': fixture.length });
        let offset = 0;
        const timer = setInterval(() => {
          res.write(fixture.subarray(offset, offset + 512)); offset += 512;
          if (offset >= fixture.length) { clearInterval(timer); res.end(); }
        }, 10);
        res.on('close', () => clearInterval(timer));
        return;
      }
      const query = url.searchParams.get('query');
      const count = (visits.get(query) || 0) + 1; visits.set(query, count);
      res.setHeader('Content-Type', 'text/html');
      res.end(query === 'Retry' && count === 1
        ? '<div class="alert-error">Backend unavailable</div>'
        : query === 'Other' && count === 1 ? '<a class="download-button" href="/wrong.flac">Download</a>'
        : '<a class="download-button" href="' + (query === 'Large' ? '/large.flac' : '/fixture.flac') + '">Download</a>');
    });
    const deadline = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 45000);
    server.listen(0, '127.0.0.1', () => {
      require(${JSON.stringify(packaged ? './app.asar/main.js' : './main.js')});
      app.whenReady().then(async () => {
        try {
          const port = server.address().port;
          session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://lucida.to/*'] }, (details, callback) => {
            const url = new URL(details.url);
            callback({ redirectURL: 'http://127.0.0.1:' + port + '/release' + url.search });
          });
          session.defaultSession.on('will-download', (_event, item) => {
            activeDownloads.add(item);
            item.once('done', () => activeDownloads.delete(item));
          });
          ipcMain.on('downloads-pause', () => { if ([...activeDownloads].some(item => item.isPaused())) sawPaused = true; });
          ipcMain.on('downloads-resume', () => { if ([...activeDownloads].some(item => !item.isPaused())) sawResumed = true; });
          const win = BrowserWindow.getAllWindows()[0];
          await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
          // Wait for the real built React app to boot before mounting the test engine.
          const ui = await win.webContents.executeJavaScript(
            'new Promise((resolve, reject) => { const until = Date.now() + 10000; const tick = () => { if (document.querySelector(".app")) resolve(document.body.innerText); else if (Date.now() > until) reject(new Error(document.body.innerText)); else setTimeout(tick, 50); }; tick(); })'
          );
          if (!ui.includes('Downloads')) throw new Error('Built UI did not boot: ' + ui);
          const keepTryingSaved = await win.webContents.executeJavaScript(
            '(async () => { [...document.querySelectorAll(".nav-item")].find(button => button.textContent.includes("Settings")).click(); await new Promise(resolve => setTimeout(resolve, 50)); const label = [...document.querySelectorAll("label.switch")].find(label => label.textContent.includes("Keep trying")); if (!label) throw new Error("Keep trying option missing"); label.querySelector("input").click(); const config = await window.require("electron").ipcRenderer.invoke("get-config"); return config.keepTrying; })()'
          );
          if (!keepTryingSaved) throw new Error('Keep trying setting was not saved');
          const results = await win.webContents.executeJavaScript(${JSON.stringify(renderer)});
          if (new Set(results.map(result => result.savePath)).size !== 3) throw new Error('Concurrent files collided');
          for (const result of results.slice(0, 2)) {
            if (!fs.readFileSync(result.savePath).equals(fixture)) throw new Error('Downloaded bytes changed');
            if (result.file !== path.basename(result.savePath)) throw new Error('Completion filename differs from actual save path');
          }
          const repaired = fs.readFileSync(results[2].savePath);
          if (!audio(repaired).equals(audio(large))) throw new Error('Artwork repair changed audio frames');
          if (repaired.length >= large.length || repaired.length !== results[2].bytes) throw new Error('Artwork size or saved byte count incorrect');
          let at = 4, picture = false, last = false;
          while (!last) {
            last = !!(repaired[at] & 0x80);
            const len = repaired.readUIntBE(at + 1, 3);
            if ((repaired[at] & 0x7f) === 6) { picture = true; if (len > 3 * 1024 * 1024) throw new Error('Artwork still oversized'); }
            at += 4 + len;
          }
          if (!picture) throw new Error('Artwork repair removed the cover');
          for (const name of ['Owner', 'Second']) {
            const dir = path.join(__dirname, 'downloads', name);
            const library = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
            if (new Set(library.playlists.map(pl => pl.file.toLowerCase())).size !== library.playlists.length) throw new Error('Playlist filename collision');
            for (const track of Object.values(library.tracks)) {
              if (!fs.readFileSync(path.join(dir, track.file)).equals(fixture)) throw new Error('Shared track copy changed');
            }
            for (const pl of library.playlists) {
              const art = fs.readFileSync(path.join(dir, pl.file.replace(/\\.m3u8$/i, '.jpg')));
              if (art[0] !== 255 || art[1] !== 216 || nativeImage.createFromBuffer(art).isEmpty()) throw new Error('Playlist cover is not a valid JPEG');
              const text = fs.readFileSync(path.join(dir, pl.file), 'utf8');
              for (const key of pl.trackKeys) if (!text.includes('../' + library.tracks[key].file)) throw new Error('Broken M3U path');
            }
          }
          if ((visits.get('Retry') || 0) < 2) throw new Error('Failed track was not automatically retried');
          if ((visits.get('Other') || 0) < 2 || fs.existsSync(path.join(__dirname, 'downloads', 'wrong.flac'))) throw new Error('Wrong recording was accepted or retained');
          if (!sawPaused || !sawResumed) throw new Error('Pause/resume did not reach live Chromium transfers');
          console.log('PASS: ${packaged ? 'packaged archive' : 'source'}, built UI, saved Keep trying option, real cascades, automatic retry, wrong remix rejected, three FLAC downloads, actual filenames, byte integrity, oversized artwork retained, audio frames unchanged, shared profile copies, distinct playlists and JPEG covers, valid M3U paths, live pause/resume, disposal and clean quit');
          clearTimeout(deadline); server.close(); app.quit();
        } catch (error) { console.error(error.stack); clearTimeout(deadline); server.close(); app.exit(1); }
      });
    });
  `;
  await fs.writeFile(path.join(sandbox, 'smoke.cjs'), bootstrap);
  await fs.writeFile(path.join(sandbox, 'package.json'), JSON.stringify({ name: `lucidafetcher-smoke-${process.pid}`, main: 'smoke.cjs' }));
  const output = await run(electron, [sandbox]);
  if (!output.includes('PASS:')) throw new Error(output || 'Smoke check exited before running');
  const manifest = JSON.parse(await fs.readFile(path.join(stateRoot, 'state', 'manifest.json'), 'utf8'));
  if (Object.keys(manifest).length !== 3) throw new Error('Quit did not flush all completed downloads to the manifest');
  const config = JSON.parse(await fs.readFile(path.join(stateRoot, 'state', 'config.json'), 'utf8'));
  if (config.keepTrying !== true) throw new Error('Keep trying preference did not survive quit');
  console.log(output.split(/\r?\n/).filter(line => line.startsWith('PASS:')).join('\n'));
  // This directory is created above solely for this check; never remove a
  // computed path unless it is still inside that temporary workspace.
  if (path.dirname(path.resolve(sandbox)) !== path.resolve(os.tmpdir()) || !path.basename(sandbox).startsWith('lucidafetcher-smoke-')) throw new Error('Unexpected smoke workspace');
  await fs.rm(sandbox, { recursive: true, force: true });
} catch (error) {
  console.error(error.message);
  console.error('Smoke artifacts retained at ' + sandbox);
  process.exitCode = 1;
}
