// Exercise a packaged UI with a read-only copy of an existing queue. All writes
// go to a temporary workspace and remote requests are blocked.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const value = flag => process.argv[process.argv.indexOf(flag) + 1];
if (!process.argv.includes('--state') || !process.argv.includes('--archive')) throw new Error('Supply --state and --archive');
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'lucida-saved-queue-'));
const state = path.join(sandbox, 'userData', 'state');
await fs.mkdir(state, { recursive: true });
await fs.mkdir(path.join(sandbox, 'downloads'));
await fs.copyFile(path.resolve(value('--archive')), path.join(sandbox, 'app.asar'));
const snapshot = JSON.parse(await fs.readFile(path.join(value('--state'), 'queue.json'), 'utf8'));
const originalConfig = JSON.parse(await fs.readFile(path.join(value('--state'), 'config.json'), 'utf8'));
snapshot.paused = true;
await fs.writeFile(path.join(state, 'queue.json'), JSON.stringify(snapshot));
let savedHistory = [];
try {
  savedHistory = JSON.parse(await fs.readFile(path.join(value('--state'), 'history.json'), 'utf8'));
  await fs.writeFile(path.join(state, 'history.json'), JSON.stringify(savedHistory));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await fs.writeFile(path.join(state, 'config.json'), JSON.stringify({
  ...originalConfig, downloadPath: path.join(sandbox, 'downloads'), sounds: false, closeToTray: false,
}));
await fs.writeFile(path.join(sandbox, 'package.json'), JSON.stringify({ name: `lucida-queue-check-${process.pid}`, main: 'check.cjs' }));
await fs.writeFile(path.join(sandbox, 'check.cjs'), `
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
app.setPath('userData', path.join(__dirname, 'userData'));
Object.defineProperty(app, 'isPackaged', { value: true });
app.getAppPath = () => path.join(__dirname, 'app.asar');
app.on('browser-window-created', (_event, win) => { win.show = () => {}; });
// This checks restore/render/audio, not library export. Do not copy the user's
// existing audio into every playlist just to exercise a settings checkbox.
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, ...args) => channel === 'profile-library-sync' ? ipcMain : on(channel, ...args);
ipcMain.handle('test-sound-click', async event => {
  const point = await event.sender.executeJavaScript(
    '(() => { const pane = document.querySelector(".main .pane"); pane.scrollTop = pane.scrollHeight; const label = [...document.querySelectorAll("label.switch")].find(el => el.textContent.includes("Play a sound")); const r = label.querySelector(".track").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()'
  );
  event.sender.sendInputEvent({ type: 'mouseMove', ...point });
  event.sender.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  event.sender.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
});
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })
));
require('./app.asar/main.js');
const deadline = setTimeout(() => { console.error('Saved queue UI check timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    const result = await win.webContents.executeJavaScript(
      '(' + ${JSON.stringify((async function () {
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const until = Date.now() + 40000;
        while (!document.querySelector('.app')) {
          if (Date.now() > until) throw new Error('App did not restore: ' + document.body.innerText.slice(0, 500));
          await delay(100);
        }
        const nav = name => [...document.querySelectorAll('.nav-item')].find(button => button.textContent.includes(name));
        if ([...document.querySelectorAll('.row.done .trail img')].some(el => el.alt === 'Spotify')) throw new Error('Metadata Spotify icon still shown as a download source');
        const head = document.querySelector('.profile-head');
        const expanded = head?.getAttribute('aria-expanded');
        if (head) { head.click(); await delay(100); }
        nav('Settings').click(); await delay(100);
        const ipc = window.require('electron').ipcRenderer;
        const toggle = () => [...document.querySelectorAll('label.switch')].find(label => label.textContent.includes('Play a sound')).querySelector('input');
        for (let n = 0; n < 11; n++) {
          await ipc.invoke('test-sound-click'); await delay(100);
          if (document.activeElement !== toggle() || toggle().checked !== (n % 2 === 0)) throw new Error('Mouse input did not focus and toggle the sound checkbox');
          if (scrollY !== 0 || document.querySelector('.app').getBoundingClientRect().top !== 0) throw new Error('Sound checkbox focus scrolled the interface out of the window');
        }
        if (!document.querySelector('.app .sidebar') || !document.querySelector('#vol') || !toggle().checked) throw new Error('Sound toggle blanked the restored interface');
        nav('Downloads').click(); await delay(100);
        if (head && document.querySelector('.profile-head')?.getAttribute('aria-expanded') === expanded) throw new Error('Saved queue lost profile expansion after navigation');
        if ((await ipc.invoke('history-get')).some(entry => entry.kind === 'profile')) {
          nav('Add music').click(); await delay(100);
          [...document.querySelectorAll('.mode-tab')].find(el => el.textContent.includes('Spotify profile')).click(); await delay(100);
          const recent = document.querySelector('.recent-profile');
          if (!recent) throw new Error('Existing profile history did not appear under the search box');
          recent.click(); await delay(100);
          if (!document.querySelector('.profile-identity')) throw new Error('Existing saved profile did not reopen');
        }
        nav('Settings').click(); await delay(100);
        document.querySelector('.pane').scrollTop = 100000;
        return { enabled: toggle().checked, navigation: document.querySelectorAll('.nav-item').length };
      }).toString())} + ')()'
    );
    await win.webContents.capturePage();
    await new Promise(resolve => setTimeout(resolve, 200));
    const capture = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'sounds-enabled.png'), capture.toPNG());
    const bitmap = capture.toBitmap(), colors = new Set();
    for (let at = 0; at + 3 < bitmap.length; at += 400) colors.add(bitmap.readUInt32LE(at));
    if (colors.size < 20) throw new Error('Window painted a blank surface');
    console.log('PASS: saved queue restored, no misleading Spotify download icons, expansion retained, existing profile history, 11 trusted mouse sound toggles, document scroll stays zero, sidebar and volume retained, painted window; ' + JSON.stringify(result));
    app.quit();
  } catch (error) { console.error(error.stack); clearTimeout(deadline); app.exit(1); }
});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [sandbox], { env, windowsHide: true });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
if (code !== 0 || !output.includes('PASS:')) {
  console.error(output);
  process.exitCode = 1;
} else console.log(output.split(/\r?\n/).filter(line => line.startsWith('PASS:')).join('\n'));
console.log('Isolated check and screenshot: ' + sandbox);
console.log(JSON.stringify({ profiles: snapshot.profiles?.length || 0, playlists: snapshot.playlists?.length || 0, tracks: snapshot.tracks?.length || 0, loose: snapshot.items?.length || 0 }));
