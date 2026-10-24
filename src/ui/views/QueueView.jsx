import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProfileTree, useStats, useQueueOrder, getController } from '../engine.js';
import TrackRow from '../components/TrackRow.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Working' },
  { id: 'paused', label: 'Paused', hideWhenZero: true },
  { id: 'done', label: 'Downloaded' },
  { id: 'missing', label: 'Missing' },
];

const matches = (rec, filter) => {
  if (filter === 'all') return true;
  if (filter === 'done') return rec.status === 'completed';
  if (filter === 'missing') return rec.status === 'skipped';
  if (filter === 'paused') return rec.status === 'paused';
  return rec.status === 'searching' || rec.status === 'fetching' || rec.status === 'ready' || rec.status === 'downloading' || rec.status === 'queued';
};

export default function QueueView({ onToast, preferences = {}, onPreferencesChange }) {
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

  return (
    <>
      <header className="topbar">
        <h1>Downloads</h1>
        {stats.total > 0 && (
          <div className="view-mode-pills" role="group" aria-label="Queue layout mode">
            <button
              type="button"
              className={`mode-pill${layoutMode === 'grouped' ? ' active' : ''}`}
              onClick={() => save({ layoutMode: 'grouped' })}
            >
              Playlists
            </button>
            <button
              type="button"
              className={`mode-pill${layoutMode === 'custom' ? ' active' : ''}`}
              onClick={() => save({ layoutMode: 'custom' })}
            >
              Queue Order
              {(stats.queued + stats.active) > 0 && <span className="pill-badge">{stats.queued + stats.active}</span>}
            </button>
          </div>
        )}
        <span className="spacer" />
        <div className="row-actions">
          {FILTERS.filter((f) => !f.hideWhenZero || (stats.paused > 0 || filter === 'paused')).map((f) => (
            <button
              key={f.id}
              className={`btn btn-sm ${filter === f.id ? '' : 'btn-ghost'}`}
              onClick={() => save({ filter: f.id })}
              aria-pressed={filter === f.id}
            >
              {f.label}
            </button>
          ))}
          {stats.skipped > 0 && (
            <button className="btn btn-sm" onClick={retry} title="Give every missing track one more pass through the whole chain">
              Retry missing ({stats.skipped})
            </button>
          )}
          {(() => {
            const allCollapsibleIds = [
              ...visible.filter((n) => n.kind === 'profile').map((n) => n.id),
              ...visibleGroups.map((g) => g.id),
            ];
            if (allCollapsibleIds.length <= 1) return null;
            const allCollapsed = allCollapsibleIds.every((id) => collapsed.has(id));
            return (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  const next = new Set(collapsed);
                  for (const id of allCollapsibleIds) {
                    if (allCollapsed) next.delete(id); else next.add(id);
                  }
                  save({ collapsed: [...next] });
                }}
              >
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            );
          })()}
        </div>
      </header>

      <div className="pane">
        {controller?.keepTrying && (
          <p className="hint" role="status">
            {controller.paused ? 'Keep trying is paused.'
              : controller.retryStopped ? 'Keep trying is stopped. Add music or retry missing tracks to start it again.'
              : controller.retryAt ? `Keep trying: missing tracks will retry at ${new Date(controller.retryAt).toLocaleTimeString()}.`
              : 'Keep trying is on. Missing tracks will retry after this queue finishes.'}
          </p>
        )}
        {!visible.length ? (
          <EmptyState filter={filter} total={stats.total} />
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
    </>
  );
}

// Custom Queue View: shows exact pool execution order with drag-and-drop
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
    <div className="custom-queue-view">
      {showActive && activeList.length > 0 && (
        <section className="queue-stage-card active-stage">
          <div className="stage-header">
            <div className="stage-title">
              <span className="pill accent live"><span className="dot" />Working</span>
              <h2>Active ({activeList.length})</h2>
            </div>
            <span className="stage-hint">Hover a track to pause</span>
          </div>
          <div className="rows">
            {activeList.map((rec, idx) => (
              <TrackRow key={rec.id || rec.item.id} rec={rec} queueIndex={idx + 1} onToast={onToast} />
            ))}
          </div>
        </section>
      )}

      {showQueued && queuedList.length > 0 && (
        <section className="queue-stage-card upnext-stage">
          <div className="stage-header">
            <div className="stage-title">
              <span className="pill info">Up Next</span>
              <h2>Queue ({queuedList.length})</h2>
            </div>
            <span className="stage-hint">Drag rows to reorder · ⚡ jumps to #1</span>
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
        <section className="queue-stage-card paused-stage">
          <div className="stage-header">
            <div className="stage-title">
              <span className="pill paused-tone">Paused</span>
              <h2>Paused ({pausedList.length})</h2>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                pausedList.forEach((rec) => c.resumeItem?.(rec.id || rec.item.id));
                onToast?.(`Resumed ${pausedList.length} paused tracks.`);
              }}
            >
              ▶ Resume all
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
        <section className="queue-stage-card rest-stage">
          <div className="stage-header">
            <div className="stage-title">
              <span className="pill">Finished</span>
              <h2>Completed & Missing ({restList.length})</h2>
            </div>
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

function Profile({ node, collapsed, onToggle, isCollapsed, onToggleGroup, onRemoveGroup, onRemove, onToast }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  const c = getController();
  const all = node.groups.flatMap((g) => g.allRecords);
  const done = all.filter((r) => r.status === 'completed').length;
  const missing = all.filter((r) => r.status === 'skipped').length;
  const paused = all.filter((r) => r.status === 'paused').length;
  const working = all.filter((r) => r.status === 'searching' || r.status === 'fetching' || r.status === 'ready' || r.status === 'downloading').length;
  const hasPausable = all.some((r) => r.status === 'queued' || r.status === 'searching' || r.status === 'fetching' || r.status === 'ready' || r.status === 'downloading');
  const hasResumable = paused > 0;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  const bodyId = `profile-body-${node.id}`;

  return (
    <section className="profile-group">
      <div className="group-head-row profile-head-row">
        <button className="group-head profile-head" onClick={onToggle} aria-expanded={!collapsed} aria-controls={bodyId}>
          <span className={`chevron${collapsed ? ' collapsed' : ''}`} aria-hidden="true">▾</span>
          {node.artwork
            ? <img className="group-art profile-art" src={node.artwork} alt="" referrerPolicy="no-referrer" />
            : <div className="group-art profile-art" aria-hidden="true" />}
          <div className="group-meta">
            <div className="name">{node.name}</div>
            <div className="sub">
              {node.groups.length} {node.groups.length === 1 ? 'playlist' : 'playlists'}
              {' · '}{done} of {all.length} downloaded
              {paused > 0 && ` · ${paused} paused`}
              {missing > 0 && ` · ${missing} missing`}
              {node.folderName && ` · ${node.folderName}/`}
            </div>
          </div>
          {collapsed && working > 0 && <span className="pill accent live"><span className="dot" />{working}</span>}
          <span className={`pill ${pct === 100 ? 'ok' : ''}`}>{pct}%</span>
        </button>
        <div className="group-QuickActions">
          {hasPausable && (
            <button
              className="btn btn-sm btn-ghost btn-icon"
              title={`Pause ${node.name}`}
              onClick={() => {
                const n = c.pauseProfile?.(node.id);
                if (n) onToast?.(`Paused ${n} tracks in ${node.name}.`);
              }}
            >❚❚</button>
          )}
          {hasResumable && (
            <button
              className="btn btn-sm btn-ghost btn-icon"
              title={`Resume ${node.name}`}
              onClick={() => {
                const n = c.resumeProfile?.(node.id);
                if (n) onToast?.(`Resumed ${n} tracks in ${node.name}.`);
              }}
            >▶</button>
          )}
          {confirming ? (
            <button className="btn btn-sm btn-danger group-remove" onClick={() => { setConfirming(false); onRemove(); }}>
              Remove all {node.totalGroups} playlists?
            </button>
          ) : (
            <button className="btn btn-sm btn-ghost btn-danger group-remove" onClick={() => setConfirming(true)}
              title={`Remove everything queued from ${node.name}`}
              aria-label={`Remove everything queued from ${node.name}`}>Remove profile</button>
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
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  const c = getController();
  const done = group.allRecords.filter((r) => r.status === 'completed').length;
  const missing = group.allRecords.filter((r) => r.status === 'skipped').length;
  const paused = group.allRecords.filter((r) => r.status === 'paused').length;
  const working = group.allRecords.filter((r) => r.status === 'searching' || r.status === 'fetching' || r.status === 'ready' || r.status === 'downloading').length;
  const hasPausable = group.allRecords.some((r) => r.status === 'queued' || r.status === 'searching' || r.status === 'fetching' || r.status === 'ready' || r.status === 'downloading');
  const hasResumable = paused > 0;
  const hasQueued = group.allRecords.some((r) => r.status === 'queued' || r.status === 'paused');
  const pct = group.totalRecords ? Math.round((done / group.totalRecords) * 100) : 0;
  const sharePct = (n) => (group.totalRecords ? (n / group.totalRecords) * 100 : 0);
  const bodyId = `group-body-${group.id}`;

  return (
    <section className="group">
      <div className="group-head-row">
        <button
          className="group-head"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
        >
          <span className={`chevron${collapsed ? ' collapsed' : ''}`} aria-hidden="true">▾</span>
          {group.artwork
            ? <img className="group-art" src={group.artwork} alt="" referrerPolicy="no-referrer" />
            : <div className="group-art" aria-hidden="true" />}
          <div className="group-meta">
            <div className="name">{group.name}</div>
            <div className="sub">
              {done} of {group.totalRecords} downloaded
              {group.records.length !== group.totalRecords && ` · showing ${group.records.length}`}
              {paused > 0 && ` · ${paused} paused`}
              {missing > 0 && ` · ${missing} missing`}
              {group.folderName && ` · ${group.folderName}`}
            </div>
          </div>
          {collapsed && working > 0 && (
            <span className="pill accent live"><span className="dot" />{working}</span>
          )}
          <span className={`pill ${pct === 100 ? 'ok' : ''}`}>{pct}%</span>
        </button>

        <div className="group-QuickActions">
          {hasPausable && (
            <button
              className="btn btn-sm btn-ghost btn-icon"
              title={`Pause “${group.name}”`}
              onClick={() => {
                const n = c.pauseGroup?.(group.id);
                if (n) onToast?.(`Paused ${n} tracks in “${group.name}”.`);
              }}
            >❚❚</button>
          )}
          {hasResumable && (
            <button
              className="btn btn-sm btn-ghost btn-icon"
              title={`Resume “${group.name}”`}
              onClick={() => {
                const n = c.resumeGroup?.(group.id);
                if (n) onToast?.(`Resumed ${n} tracks in “${group.name}”.`);
              }}
            >▶</button>
          )}
          {hasQueued && group.id !== '__loose__' && (
            <button
              className="btn btn-sm btn-ghost btn-icon"
              title={`Download “${group.name}” now`}
              onClick={() => {
                c.prioritizeGroup?.(group.id, { preempt: true });
                onToast?.(`Prioritized “${group.name}”.`);
              }}
            >⚡</button>
          )}
          {confirming ? (
            <button
              className="btn btn-sm btn-danger group-remove"
              onClick={() => { setConfirming(false); onRemove(); }}
            >Remove playlist ({group.totalRecords})?</button>
          ) : (
            <button
              className="btn btn-sm btn-ghost btn-danger group-remove"
              onClick={() => setConfirming(true)}
              title={`Remove “${group.name}” from the list`}
              aria-label={`Remove ${group.name} from the list`}
            >Remove playlist</button>
          )}
        </div>
      </div>

      <div className="group-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
           aria-label={`${group.name}: ${pct}% downloaded`}>
        <span className="seg done" style={{ width: `${sharePct(done)}%` }} />
        <span className="seg working" style={{ width: `${sharePct(working)}%` }} />
        <span className="seg missing" style={{ width: `${sharePct(missing)}%` }} />
      </div>
      {!collapsed && (
        <div className="rows" id={bodyId}>
          {group.records.map((rec) => <TrackRow key={rec.id || rec.item.id} rec={rec} onToast={onToast} />)}
        </div>
      )}
    </section>
  );
}

function EmptyState({ filter, total }) {
  if (total === 0) {
    return (
      <div className="empty">
        <div className="big">♪</div>
        <h3>Nothing queued yet</h3>
        <p>Paste a Spotify, Deezer or Lucida link under <strong>Add music</strong>, or search for a track, album, or artist.</p>
      </div>
    );
  }
  const label = FILTERS.find((f) => f.id === filter)?.label.toLowerCase();
  return (
    <div className="empty">
      <div className="big">✓</div>
      <h3>Nothing {label === 'all' ? 'here' : label}</h3>
      <p>No tracks match this filter right now.</p>
    </div>
  );
}
