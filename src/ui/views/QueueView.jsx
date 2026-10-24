import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProfileTree, useStats, useQueueOrder, getController } from '../engine.js';
import TrackRow from '../components/TrackRow.jsx';
import Icon from '../components/Icon.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Working' },
  { id: 'paused', label: 'Paused', hideWhenZero: true },
  { id: 'done', label: 'Downloaded' },
  { id: 'missing', label: 'Missing' },
];

const WORKING = new Set(['searching', 'fetching', 'ready', 'downloading']);

const matches = (rec, filter) => {
  if (filter === 'all') return true;
  if (filter === 'done') return rec.status === 'completed';
  if (filter === 'missing') return rec.status === 'skipped';
  if (filter === 'paused') return rec.status === 'paused';
  return WORKING.has(rec.status) || rec.status === 'queued';
};

/** done / missing / paused / working counts for a set of records, in one pass. */
function tally(records) {
  const t = { done: 0, missing: 0, paused: 0, working: 0, pausable: false, queued: false };
  for (const r of records) {
    if (r.status === 'completed') t.done++;
    else if (r.status === 'skipped') t.missing++;
    else if (r.status === 'paused') { t.paused++; t.queued = true; }
    else if (WORKING.has(r.status)) { t.working++; t.pausable = true; }
    else if (r.status === 'queued') { t.pausable = true; t.queued = true; }
  }
  return t;
}

export default function QueueView({ onToast, preferences = {}, onPreferencesChange, onAddMusic }) {
  const tree = useProfileTree();
  const stats = useStats();
  const orderData = useQueueOrder();
  const filter = FILTERS.some(f => f.id === preferences?.filter) ? preferences.filter : 'all';
  const layoutMode = preferences?.layoutMode || 'grouped'; // 'grouped' | 'custom'
  const collapsed = new Set(Array.isArray(preferences?.collapsed) ? preferences.collapsed : []);
  // App owns these preferences and saves them in config.json, so unmounting
  // this view or restarting the portable app does not reset the queue tree.
  const save = (next) => onPreferencesChange({ filter, collapsed: [...collapsed], layoutMode, ...next });
  const controller = getController();

  const toggle = (id) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    save({ collapsed: [...next] });
  };

  const shape = (g) => ({ ...g, allRecords: g.records, totalRecords: g.records.length, records: g.records.filter((r) => matches(r, filter)) });
  // A profile survives the filter if any of its playlists does, so "Missing"
  // shows the profile with only the playlists that are missing something -
  // which is the list the user opened that filter to get.
  const visible = tree
    .map((node) => (node.kind === 'profile'
      ? { ...node, totalGroups: node.groups.length, groups: node.groups.map(shape).filter((g) => g.records.length) }
      : { ...node, group: shape(node.group) }))
    .filter((node) => (node.kind === 'profile' ? node.groups.length : node.group.records.length));
  const visibleGroups = visible.flatMap((node) => (node.kind === 'profile' ? node.groups : [node.group]));

  // Remove the whole playlist even when a status filter hides some tracks.
  const removeGroup = (group) => {
    if (!controller) return;
    const n = controller.removeGroup(group.id);
    onToast(n ? `Removed ${n} track${n === 1 ? '' : 's'} from the list. Files already downloaded are untouched.` : 'Nothing to remove.');
  };

  // A profile is a queue of forty playlists; removing it one playlist at a time
  // is not a thing anyone would sit through.
  const removeProfile = (node) => {
    if (!controller) return;
    const n = controller.removeProfile(node.id);
    onToast(n
      ? `Removed ${n} track${n === 1 ? '' : 's'} from ${node.name}. Files already downloaded are untouched.`
      : 'Nothing to remove.');
  };

  const retry = () => {
    if (!controller) return;
    const n = controller.retrySkipped({ force: true });
    onToast(n ? `Requeued ${n} missing track${n === 1 ? '' : 's'}.` : 'Nothing left to retry.');
  };

  const filterCount = {
    all: stats.total, active: stats.queued + stats.active, paused: stats.paused || 0,
    done: stats.completed, missing: stats.skipped,
  };

  const collapsibleIds = [
    ...visible.filter((n) => n.kind === 'profile').map((n) => n.id),
    ...visibleGroups.map((g) => g.id),
  ];
  const allCollapsed = collapsibleIds.length > 0 && collapsibleIds.every((id) => collapsed.has(id));

  return (
    <>
      <header className="topbar">
        <h1>Downloads</h1>
        {stats.total > 0 && (
          <div className="segmented" role="group" aria-label="Queue layout">
            <button type="button" className="seg-btn" aria-pressed={layoutMode === 'grouped'} onClick={() => save({ layoutMode: 'grouped' })}>
              <Icon name="layers" size={14} />Playlists
            </button>
            <button type="button" className="seg-btn" aria-pressed={layoutMode === 'custom'} onClick={() => save({ layoutMode: 'custom' })}>
              <Icon name="list" size={14} />Queue order
            </button>
          </div>
        )}
        <span className="spacer" />
        {stats.total > 0 && (
          <div className="segmented" role="group" aria-label="Filter tracks">
            {FILTERS.filter((f) => !f.hideWhenZero || (stats.paused > 0 || filter === 'paused')).map((f) => (
              <button
                key={f.id}
                type="button"
                className="seg-btn"
                onClick={() => save({ filter: f.id })}
                aria-pressed={filter === f.id}
                // The count is drawn from this attribute by CSS so the button's
                // text stays exactly its label.
                data-count={filterCount[f.id] > 0 ? filterCount[f.id] : undefined}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        {filter === 'missing' && stats.skipped > 0 && (
          <button className="btn btn-sm" onClick={retry} title="Give every missing track one more pass through the whole chain">
            <Icon name="retry" size={14} />Retry all
          </button>
        )}
        {layoutMode === 'grouped' && collapsibleIds.length > 1 && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              const next = new Set(collapsed);
              for (const id of collapsibleIds) {
                if (allCollapsed) next.delete(id); else next.add(id);
              }
              save({ collapsed: [...next] });
            }}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </header>

      <div className="pane">
        <div className="pane-inner">
          {controller?.keepTrying && (
            <p className="banner" role="status">
              <Icon name="retry" size={14} />
              {controller.paused ? 'Keep trying is paused.'
                : controller.retryStopped ? 'Keep trying is stopped. Add music or retry missing tracks to start it again.'
                : controller.retryAt ? `Keep trying: missing tracks will retry at ${new Date(controller.retryAt).toLocaleTimeString()}.`
                : 'Keep trying is on. Missing tracks will retry after this queue finishes.'}
            </p>
          )}
          {!visible.length ? (
            <EmptyState filter={filter} total={stats.total} onAddMusic={onAddMusic} onShowAll={() => save({ filter: 'all' })} />
          ) : layoutMode === 'custom' ? (
            <CustomQueuePanel orderData={orderData} filter={filter} onToast={onToast} />
          ) : (
            visible.map((node) => (node.kind === 'profile' ? (
              <Profile
                key={node.id}
                node={node}
                collapsed={collapsed.has(node.id)}
                onToggle={() => toggle(node.id)}
                isCollapsed={(id) => collapsed.has(id)}
                onToggleGroup={toggle}
                onRemoveGroup={removeGroup}
                onRemove={() => removeProfile(node)}
                onToast={onToast}
              />
            ) : (
              <Group
                key={node.group.id}
                group={node.group}
                collapsed={collapsed.has(node.group.id)}
                onToggle={() => toggle(node.group.id)}
                onRemove={() => removeGroup(node.group)}
                onToast={onToast}
              />
            )))
          )}
        </div>
      </div>
    </>
  );
}

// Queue-order layout: the exact pool execution order, with drag-and-drop.
function CustomQueuePanel({ orderData, filter, onToast }) {
  const c = getController();
  const [dragFromId, setDragFromId] = useState(null);
  const [dragTargetId, setDragTargetId] = useState(null);

  const handleDragStart = useCallback((e, id) => {
    setDragFromId(id);
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    } catch { /* ignore */ }
  }, []);

  const handleDragOver = useCallback((e, id) => {
    e.preventDefault();
    if (id !== dragTargetId) setDragTargetId(id);
  }, [dragTargetId]);

  const handleDrop = useCallback((e, targetId) => {
    e.preventDefault();
    const fromId = dragFromId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
    setDragFromId(null);
    setDragTargetId(null);
    if (fromId && targetId && fromId !== targetId) {
      c.reorderItem?.(fromId, targetId);
    }
  }, [c, dragFromId]);

  const activeList = orderData.active || [];
  const queuedList = orderData.queued || [];
  const pausedList = orderData.paused || [];
  const restList = useMemo(() => {
    const raw = orderData.rest || [];
    if (filter === 'done') return raw.filter((i) => i.status === 'completed');
    if (filter === 'missing') return raw.filter((i) => i.status === 'skipped');
    return raw;
  }, [orderData.rest, filter]);

  const showActive = filter === 'all' || filter === 'active';
  const showQueued = filter === 'all' || filter === 'active';
  const showPaused = filter === 'all' || filter === 'paused' || filter === 'active';
  const showRest = filter === 'all' || filter === 'done' || filter === 'missing';

  return (
    <div className="stages">
      {showActive && activeList.length > 0 && (
        <section>
          <div className="stage-head">
            <span className="pill accent live"><span className="dot" />Now</span>
            <h2>Working <span className="count">{activeList.length}</span></h2>
          </div>
          <div className="rows">
            {activeList.map((rec, idx) => (
              <TrackRow key={rec.id || rec.item.id} rec={rec} queueIndex={idx + 1} onToast={onToast} />
            ))}
          </div>
        </section>
      )}

      {showQueued && queuedList.length > 0 && (
        <section>
          <div className="stage-head">
            <span className="pill info">Next</span>
            <h2>Up next <span className="count">{queuedList.length}</span></h2>
            <span className="stage-hint">Drag to reorder</span>
          </div>
          <div className="rows">
            {queuedList.map((rec, idx) => (
              <TrackRow
                key={rec.id || rec.item.id}
                rec={rec}
                queueIndex={idx + 1}
                draggableQueue
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                isDragTarget={dragTargetId === (rec.id || rec.item.id)}
                onToast={onToast}
              />
            ))}
          </div>
        </section>
      )}

      {showPaused && pausedList.length > 0 && (
        <section>
          <div className="stage-head">
            <span className="pill paused-tone">Paused</span>
            <h2>Paused <span className="count">{pausedList.length}</span></h2>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                pausedList.forEach((rec) => c.resumeItem?.(rec.id || rec.item.id));
                onToast?.(`Resumed ${pausedList.length} paused tracks.`);
              }}
            >
              <Icon name="play" size={12} />Resume all
            </button>
          </div>
          <div className="rows">
            {pausedList.map((rec) => (
              <TrackRow key={rec.id || rec.item.id} rec={rec} onToast={onToast} />
            ))}
          </div>
        </section>
      )}

      {showRest && restList.length > 0 && (
        <section>
          <div className="stage-head">
            <span className="pill">Finished</span>
            <h2>Downloaded &amp; missing <span className="count">{restList.length}</span></h2>
          </div>
          <div className="rows">
            {restList.map((rec) => (
              <TrackRow key={rec.id || rec.item.id} rec={rec} onToast={onToast} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Two-step remove: the first click arms it, the second within 5s commits. */
function useConfirm() {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);
  return [confirming, setConfirming];
}

function GroupProgress({ total, t }) {
  const pct = total ? Math.round((t.done / total) * 100) : 0;
  const share = (n) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className="group-progress">
      <div className="seg-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% downloaded`}>
        <span className="seg done" style={{ width: share(t.done) }} />
        <span className="seg working" style={{ width: share(t.working) }} />
        <span className="seg missing" style={{ width: share(t.missing) }} />
      </div>
      <span className={`pct${pct === 100 ? ' ok' : ''}`}>{pct}%</span>
    </div>
  );
}

function SubLine({ parts, missing, paused, working, collapsed }) {
  return (
    <div className="sub">
      {parts.filter(Boolean).join(' · ')}
      {collapsed && working > 0 && ` · ${working} working`}
      {paused > 0 && ` · ${paused} paused`}
      {missing > 0 && <> · <span className="warn-text">{missing} missing</span></>}
    </div>
  );
}

function Profile({ node, collapsed, onToggle, isCollapsed, onToggleGroup, onRemoveGroup, onRemove, onToast }) {
  const [confirming, setConfirming] = useConfirm();
  const c = getController();
  const all = node.groups.flatMap((g) => g.allRecords);
  const t = tally(all);
  const bodyId = `profile-body-${node.id}`;

  return (
    <section className="profile-group">
      <div className="group-head-row">
        <button className="group-head profile-head" onClick={onToggle} aria-expanded={!collapsed} aria-controls={bodyId}>
          <Icon name="chevronDown" size={16} className={`chevron${collapsed ? ' collapsed' : ''}`} />
          {node.artwork
            ? <img className="group-art profile-art" src={node.artwork} alt="" referrerPolicy="no-referrer" />
            : <div className="group-art profile-art" aria-hidden="true"><Icon name="user" size={20} /></div>}
          <div className="group-meta">
            <div className="name">{node.name}</div>
            <SubLine
              parts={[
                `${node.groups.length} ${node.groups.length === 1 ? 'playlist' : 'playlists'}`,
                `${t.done} of ${all.length} downloaded`,
                node.folderName && `${node.folderName}/`,
              ]}
              missing={t.missing} paused={t.paused} working={t.working} collapsed={collapsed}
            />
          </div>
          <GroupProgress total={all.length} t={t} />
        </button>
        <div className="group-actions">
          {t.pausable && (
            <button className="icon-btn" title={`Pause ${node.name}`} aria-label={`Pause ${node.name}`}
              onClick={() => { const n = c.pauseProfile?.(node.id); if (n) onToast?.(`Paused ${n} tracks in ${node.name}.`); }}>
              <Icon name="pause" size={13} />
            </button>
          )}
          {t.paused > 0 && (
            <button className="icon-btn" title={`Resume ${node.name}`} aria-label={`Resume ${node.name}`}
              onClick={() => { const n = c.resumeProfile?.(node.id); if (n) onToast?.(`Resumed ${n} tracks in ${node.name}.`); }}>
              <Icon name="play" size={13} />
            </button>
          )}
          {confirming ? (
            <button className="btn btn-sm btn-danger confirm" onClick={() => { setConfirming(false); onRemove(); }}>
              Remove {node.totalGroups} playlists?
            </button>
          ) : (
            <button className="icon-btn danger" onClick={() => setConfirming(true)}
              title={`Remove everything queued from ${node.name}`}
              aria-label={`Remove everything queued from ${node.name}`}>
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="profile-body" id={bodyId}>
          {node.groups.map((g) => (
            <Group
              key={g.id}
              group={g}
              collapsed={isCollapsed(g.id)}
              onToggle={() => onToggleGroup(g.id)}
              onRemove={() => onRemoveGroup(g)}
              onToast={onToast}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Group({ group, collapsed, onToggle, onRemove, onToast }) {
  const [confirming, setConfirming] = useConfirm();
  const c = getController();
  const t = tally(group.allRecords);
  const bodyId = `group-body-${group.id}`;
  const loose = group.id === '__loose__';

  return (
    <section className="group">
      <div className="group-head-row">
        <button className="group-head" onClick={onToggle} aria-expanded={!collapsed} aria-controls={bodyId}>
          <Icon name="chevronDown" size={16} className={`chevron${collapsed ? ' collapsed' : ''}`} />
          {group.artwork
            ? <img className="group-art" src={group.artwork} alt="" referrerPolicy="no-referrer" />
            : <div className="group-art" aria-hidden="true"><Icon name={loose ? 'music' : 'disc'} size={20} /></div>}
          <div className="group-meta">
            <div className="name">{group.name}</div>
            <SubLine
              parts={[
                `${t.done} of ${group.totalRecords} downloaded`,
                group.records.length !== group.totalRecords && `showing ${group.records.length}`,
                group.folderName,
              ]}
              missing={t.missing} paused={t.paused} working={t.working} collapsed={collapsed}
            />
          </div>
          <GroupProgress total={group.totalRecords} t={t} />
        </button>

        <div className="group-actions">
          {t.pausable && (
            <button className="icon-btn" title={`Pause “${group.name}”`} aria-label={`Pause ${group.name}`}
              onClick={() => { const n = c.pauseGroup?.(group.id); if (n) onToast?.(`Paused ${n} tracks in “${group.name}”.`); }}>
              <Icon name="pause" size={13} />
            </button>
          )}
          {t.paused > 0 && (
            <button className="icon-btn" title={`Resume “${group.name}”`} aria-label={`Resume ${group.name}`}
              onClick={() => { const n = c.resumeGroup?.(group.id); if (n) onToast?.(`Resumed ${n} tracks in “${group.name}”.`); }}>
              <Icon name="play" size={13} />
            </button>
          )}
          {t.queued && !loose && (
            <button className="icon-btn priority" title={`Download “${group.name}” now`} aria-label={`Download ${group.name} now`}
              onClick={() => { c.prioritizeGroup?.(group.id, { preempt: true }); onToast?.(`Prioritized “${group.name}”.`); }}>
              <Icon name="zap" size={13} />
            </button>
          )}
          {confirming ? (
            <button className="btn btn-sm btn-danger confirm" onClick={() => { setConfirming(false); onRemove(); }}>
              Remove {group.totalRecords} tracks?
            </button>
          ) : (
            <button className="icon-btn danger" onClick={() => setConfirming(true)}
              title={`Remove “${group.name}” from the list`}
              aria-label={`Remove ${group.name} from the list`}>
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="rows" id={bodyId}>
          {group.records.map((rec) => <TrackRow key={rec.id || rec.item.id} rec={rec} onToast={onToast} />)}
        </div>
      )}
    </section>
  );
}

function EmptyState({ filter, total, onAddMusic, onShowAll }) {
  if (total === 0) {
    return (
      <div className="empty">
        <div className="empty-icon"><Icon name="download" size={24} /></div>
        <h3>Nothing queued yet</h3>
        <p>Search for a song, album or artist, or paste a Spotify or Deezer link.</p>
        {onAddMusic && (
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onAddMusic}>
            <Icon name="plus" size={15} />Add music
          </button>
        )}
      </div>
    );
  }
  const label = FILTERS.find((f) => f.id === filter)?.label.toLowerCase();
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name="check" size={24} /></div>
      <h3>Nothing {label === 'all' ? 'here' : label}</h3>
      <p>No tracks match this filter right now.</p>
      <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={onShowAll}>Show all</button>
    </div>
  );
}
