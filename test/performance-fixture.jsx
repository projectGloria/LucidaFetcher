import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import QueueView from '../src/ui/views/QueueView.jsx';
import BaselineQueue from 'baseline:queue';
import { initEngine } from '../src/ui/engine.js';
import '../src/ui/styles.css';

const controller = await initEngine({ config: {}, log() {} });
controller.pause();
const listeners = new Set();
let records = [], version = 0;
controller.subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
controller.getSnapshot = () => version;
controller.getItems = () => records;
controller.getStats = () => ({ total: records.length, queued: records.filter(r => r.status === 'queued').length,
  skipped: records.filter(r => r.status === 'skipped').length, active: 0, completed: 0, paused: 0 });
Object.defineProperty(controller, 'stats', { get: () => controller.getStats() });
controller.getQueueOrder = () => ({ active: [], queued: records.filter(r => r.status === 'queued'), paused: [], rest: records.filter(r => r.status === 'skipped') });
controller.reorderItem = (from, to) => {
  const a = records.findIndex(r => r.item.id === from), b = records.findIndex(r => r.item.id === to);
  records.splice(b, 0, records.splice(a, 1)[0]); version++; listeners.forEach(fn => fn());
};
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const root = createRoot(document.getElementById('root'));
function Fixture({ baseline, layout }) {
  const [preferences, setPreferences] = useState({ filter: 'all', collapsed: [], layoutMode: layout });
  const View = baseline ? BaselineQueue : QueueView;
  return <div style={{ height: 760, display: 'flex', flexDirection: 'column' }}>
    <View preferences={preferences} onPreferencesChange={setPreferences} onToast={() => {}} />
  </div>;
}
window.runQueueBenchmark = async (count, baseline, layout) => {
  records = Array.from({ length: count }, (_, n) => ({ item: { id: `track-${n}`, title: `Track ${n}`, artist: 'Fixture artist',
    groupId: layout === 'grouped' ? `group-${Math.floor(n / 100)}` : null, groupName: `Playlist ${Math.floor(n / 100)}` },
    status: n % 10 === 0 ? 'skipped' : 'queued', statusText: n % 10 === 0 ? 'Missing' : 'Queued' }));
  const start = performance.now();
  flushSync(() => root.render(<Fixture key={`${baseline}-${count}-${layout}`} baseline={baseline} layout={layout} />));
  document.body.getBoundingClientRect();
  const mountMs = performance.now() - start;
  await nextFrame();
  const rows = document.querySelectorAll('.row').length;
  const filter = [...document.querySelectorAll('.seg-btn')].find(button => button.textContent === 'Missing');
  const filterStart = performance.now(); flushSync(() => filter.click()); document.body.getBoundingClientRect();
  const filterMs = performance.now() - filterStart;
  await nextFrame();
  const filteredRows = document.querySelectorAll('.row').length;
  const all = [...document.querySelectorAll('.seg-btn')].find(button => button.textContent === 'All');
  flushSync(() => all.click()); await nextFrame();
  const pane = document.querySelector('.pane'); pane.scrollTop = pane.scrollHeight; await nextFrame();
  const bottomRows = document.querySelectorAll('.row').length;
  if (!baseline && (rows > 100 || bottomRows > 100 || !bottomRows)) throw new Error(`Virtual row bounds failed: ${rows}/${bottomRows}`);
  if (!baseline) {
    const button = document.querySelector('.row button');
    button?.focus(); button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await nextFrame();
    if (!document.activeElement?.closest('.row')) throw new Error('Keyboard navigation lost row focus');
    if (layout === 'custom') {
      pane.scrollTop = 0; await nextFrame();
      const before = records.filter(r => r.status === 'queued').map(r => r.item.id);
      const dragRows = [...document.querySelectorAll('.row[draggable="true"]')];
      const transfer = new DataTransfer();
      dragRows[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      dragRows[1].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }));
      dragRows[1].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      await nextFrame();
      const after = records.filter(r => r.status === 'queued').map(r => r.item.id);
      if (after[0] !== before[1] || after[1] !== before[0]) throw new Error('Virtual drag ordering lost stable IDs');
    }
  }
  return { count, baseline, layout, mountMs, filterMs, rows, filteredRows, bottomRows,
    heapBytes: performance.memory?.usedJSHeapSize || null };
};
