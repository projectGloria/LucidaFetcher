import { useEffect, useState } from 'react';
import { useProfileTree, useStats, getController } from '../engine.js';
import TrackRow from '../components/TrackRow.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Working' },
  { id: 'done', label: 'Downloaded' },
  { id: 'missing', label: 'Missing' },
];

const matches = (rec, filter) => {
  if (filter === 'all') return true;
  if (filter === 'done') return rec.status === 'completed';
  if (filter === 'missing') return rec.status === 'skipped';
  return rec.status === 'searching' || rec.status === 'ready' || rec.status === 'downloading' || rec.status === 'queued';
};

export default function QueueView({ onToast }) {
  const tree = useProfileTree();
  const stats = useStats();
  const [filter, setFilter] = useState('all');
  // Collapsed rather than expanded, so a group's state survives it being
  // filtered out and back in without the set having to be seeded.
  const [collapsed, setCollapsed] = useState(() => new Set());
  const controller = getController();

  const toggle = (id) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const shape = (g) => ({ ...g, allRecords: g.records, totalRecords: g.records.length, records: g.records.filter((r) => matches(r, filter)) });
  // A profile survives the filter if any of its playlists does, so "Missing"
  // shows the profile with only the playlists that are missing something -
  // which is the list the user opened that filter to get.
  const visible = tree
    .map((node) => (node.kind === 'profile'
      ? { ...node, groups: node.groups.map(shape).filter((g) => g.records.length) }
      : { ...node, group: shape(node.group) }))
    .filter((node) => (node.kind === 'profile' ? node.groups.length : node.group.records.length));
  const visibleGroups = visible.flatMap((node) => (node.kind === 'profile' ? node.groups : [node.group]));

  // Remove the whole playlist even when a status filter hides some tracks.
  const removeGroup = (group) => {
    const n = controller.removeGroup(group.id);
    onToast(n ? `Removed ${n} track${n === 1 ? '' : 's'} from the list. Files already downloaded are untouched.` : 'Nothing to remove.');
  };

  // A profile is a queue of forty playlists; removing it one playlist at a time
  // is not a thing anyone would sit through.
  const removeProfile = (node) => {
    const n = node.groups.reduce((sum, g) => sum + controller.removeGroup(g.id), 0);
    onToast(n
      ? `Removed ${n} track${n === 1 ? '' : 's'} from ${node.name}. Files already downloaded are untouched.`
      : 'Nothing to remove.');
  };

  const retry = () => {
    const n = controller.retrySkipped();
    onToast(n ? `Requeued ${n} missing track${n === 1 ? '' : 's'}.` : 'Nothing left to retry.');
  };

  return (
    <>
      <header className="topbar">
        <h1>Downloads</h1>
        <span className="spacer" />
        <div className="row-actions">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`btn btn-sm ${filter === f.id ? '' : 'btn-ghost'}`}
              onClick={() => setFilter(f.id)}
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
          {visibleGroups.length > 1 && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setCollapsed(visibleGroups.every(g => collapsed.has(g.id)) ? new Set() : new Set(visibleGroups.map(g => g.id)))}
            >
              {visibleGroups.every(g => collapsed.has(g.id)) ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
      </header>

      <div className="pane">
        {!visible.length ? (
          <EmptyState filter={filter} total={stats.total} />
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
            />
          ) : (
            <Group
              key={node.group.id}
              group={node.group}
              collapsed={collapsed.has(node.group.id)}
              onToggle={() => toggle(node.group.id)}
              onRemove={() => removeGroup(node.group)}
            />
          )))
        )}
      </div>
    </>
  );
}

/**
 * A whole profile: one row that stands for every playlist downloaded from one
 * person, with the playlists nested inside it and the tracks nested inside
 * those. Three levels rather than a flat list of forty sections, because a
 * profile download queues forty at once and the flat version buries everything
 * else the user has going on.
 *
 * The counts are summed over the profile's playlists rather than recomputed
 * from the records, so what the header claims and what the rows show cannot
 * drift apart while a filter is on.
 */
function Profile({ node, collapsed, onToggle, isCollapsed, onToggleGroup, onRemoveGroup, onRemove }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  const all = node.groups.flatMap((g) => g.allRecords);
  const done = all.filter((r) => r.status === 'completed').length;
  const missing = all.filter((r) => r.status === 'skipped').length;
  const working = all.filter((r) => r.status === 'searching' || r.status === 'ready' || r.status === 'downloading').length;
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
              {missing > 0 && ` · ${missing} missing`}
              {node.folderName && ` · ${node.folderName}/`}
            </div>
          </div>
          {collapsed && working > 0 && <span className="pill accent live"><span className="dot" />{working}</span>}
          <span className={`pill ${pct === 100 ? 'ok' : ''}`}>{pct}%</span>
        </button>
        {confirming ? (
          <button className="btn btn-sm btn-danger group-remove" onClick={() => { setConfirming(false); onRemove(); }}>
            Remove {node.groups.length} playlists?
          </button>
        ) : (
          <button className="btn btn-sm btn-ghost btn-danger group-remove" onClick={() => setConfirming(true)}
            title={`Remove everything queued from ${node.name}`}
            aria-label={`Remove everything queued from ${node.name}`}>Remove profile</button>
        )}
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
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Group({ group, collapsed, onToggle, onRemove }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  const done = group.allRecords.filter((r) => r.status === 'completed').length;
  const missing = group.allRecords.filter((r) => r.status === 'skipped').length;
  const working = group.allRecords.filter((r) => r.status === 'searching' || r.status === 'ready' || r.status === 'downloading').length;
  const pct = group.totalRecords ? Math.round((done / group.totalRecords) * 100) : 0;
  const sharePct = (n) => (group.totalRecords ? (n / group.totalRecords) * 100 : 0);
  const bodyId = `group-body-${group.id}`;

  return (
    <section className="group">
      {/* The toggle is the whole header rather than the chevron alone: a 14px
          target is a poor one for something the user hits constantly on a long
          list. The remove button is a SIBLING of that button, not a child -
          nesting one button inside another is invalid, and browsers resolve it
          by dropping the inner one. */}
      <div className="group-head-row">
      <button
        className="group-head"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
      >
        <span className={`chevron${collapsed ? ' collapsed' : ''}`} aria-hidden="true">▾</span>
        {group.artwork
          ? <img className="group-art" src={group.artwork} alt="" />
          : <div className="group-art" aria-hidden="true" />}
        <div className="group-meta">
          <div className="name">{group.name}</div>
          <div className="sub">
            {done} of {group.totalRecords} downloaded
            {group.records.length !== group.totalRecords && ` · showing ${group.records.length}`}
            {missing > 0 && ` · ${missing} missing`}
            {group.folderName && ` · ${group.folderName}`}
          </div>
        </div>
        {/* Collapsed groups still have to show that something is happening
            inside them, or the app looks idle while it is working. */}
        {collapsed && working > 0 && (
          <span className="pill accent live"><span className="dot" />{working}</span>
        )}
        <span className={`pill ${pct === 100 ? 'ok' : ''}`}>{pct}%</span>
      </button>
        {/* Two steps, because one click would otherwise throw away a queue that
            took a hundred requests to build - and undo does not exist here. The
            armed state expires on its own so it cannot be left primed. */}
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
      {/* One bar per playlist, segmented rather than single-valued: done,
          working and missing are three different facts about the same list,
          and a bar that only shows "done" makes a stalled playlist and a
          working one look identical. Aligned with the header text, not
          full-bleed - it belongs to the header, it is not a divider. */}
      <div className="group-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
           aria-label={`${group.name}: ${pct}% downloaded`}>
        <span className="seg done" style={{ width: `${sharePct(done)}%` }} />
        <span className="seg working" style={{ width: `${sharePct(working)}%` }} />
        <span className="seg missing" style={{ width: `${sharePct(missing)}%` }} />
      </div>
      {!collapsed && (
        <div className="rows" id={bodyId}>
          {group.records.map((rec) => <TrackRow key={rec.item.id} rec={rec} />)}
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
        <p>Paste a SoundCloud, YouTube, Spotify, Deezer or Lucida link under <strong>Add music</strong>, or search for a single track.</p>
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
