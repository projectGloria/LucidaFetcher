import { useLayoutEffect, useRef, useState } from 'react';
import { visibleRange } from '../../engine/virtual-range.mjs';

// Nested lists share the pane viewport. Offscreen lists keep their scroll height
// but no mounted track components; a focused row stays mounted until blur.
export default function VirtualRows({ records, children, id }) {
  const root = useRef(null);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [height, setHeight] = useState(48);
  const [focused, setFocused] = useState(null);
  const key = rec => rec.id || rec.item.id;
  useLayoutEffect(() => {
    const element = root.current, pane = element.closest('.pane') || element.parentElement;
    let frame;
    const measure = () => {
      const h = parseFloat(getComputedStyle(element).getPropertyValue('--row-h')) || 48;
      setHeight(h);
      const next = visibleRange(records.length, element.getBoundingClientRect().top - pane.getBoundingClientRect().top, pane.clientHeight, h);
      setRange(old => old.start === next.start && old.end === next.end ? old : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(pane); observer.observe(pane.firstElementChild || pane);
    pane.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule); measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); pane.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [records]);
  const indices = Array.from({ length: Math.max(0, range.end - range.start) }, (_, n) => range.start + n);
  const focusIndex = focused == null ? -1 : records.findIndex(rec => key(rec) === focused);
  if (focusIndex >= 0 && !indices.includes(focusIndex)) indices.push(focusIndex);
  const focusRow = index => {
    const pane = root.current.closest('.pane');
    if (!pane) return;
    pane.scrollTop += root.current.getBoundingClientRect().top - pane.getBoundingClientRect().top + index * height - pane.clientHeight / 2;
    setFocused(key(records[index]));
    requestAnimationFrame(() => root.current.querySelector(`[data-virtual-index="${index}"] button`)?.focus());
  };
  return <div className="rows virtual-rows" id={id} ref={root} style={{ height: records.length * height, position: 'relative' }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null); }}>
    {indices.sort((a, b) => a - b).map(index => records[index] && <div key={key(records[index])} data-virtual-index={index}
      style={{ position: 'absolute', top: index * height, height, width: '100%' }}
      onFocus={() => setFocused(key(records[index]))}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        focusRow(event.key === 'Home' ? 0 : event.key === 'End' ? records.length - 1
          : Math.max(0, Math.min(records.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
      }}>{children(records[index], index)}</div>)}
  </div>;
}
