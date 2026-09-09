// A DOM small enough to run the injected cascade scripts against, and no
// larger. It models only what those scripts actually touch: class/attribute
// selectors, innerText, getComputedStyle().display, a MutationObserver on the
// notice container, and HTMLAnchorElement.prototype.click.
//
// The point is to exercise the real generated script - the one that ships into
// the webview - rather than a re-implementation of its logic.

class El {
  constructor(tag, { cls = [], text = null, attrs = {}, children = [] } = {}) {
    this.tag = tag;
    this.cls = cls;
    this.attrs = attrs;
    this.children = children;
    this._text = text;
    this._display = 'none';
    this.onclick = null;
    children.forEach((c) => { c.parent = this; });
  }

  get innerText() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.innerText).filter(Boolean).join('\n');
  }
  set innerText(v) {
    this._text = v;
    this.children = [];
    if (this.observers) this.observers.forEach((fn) => fn());
  }

  // Real anchors expose href as a property, not only as an attribute, and the
  // cascade reads it that way.
  get href() { return this.attrs.href; }
  set href(v) { this.attrs.href = v; }

  get dataset() {
    const d = {};
    for (const [k, v] of Object.entries(this.attrs)) {
      if (k.startsWith('data-')) d[k.slice(5)] = v;
    }
    return d;
  }

  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  matches(sel) {
    const m = sel.match(/^(\w+)?(?:\.([\w-]+))?(?:\[([\w-]+)([*^]?=)"?([^\]"]+)"?\])?$/);
    if (!m) return false;
    const [, tag, cls, attr, op, val] = m;
    if (tag && this.tag !== tag) return false;
    if (cls && !this.cls.includes(cls)) return false;
    if (attr) {
      const have = this.attrs[attr];
      if (have === undefined) return false;
      if (op === '*=' ? !String(have).includes(val) : String(have) !== val) return false;
    }
    return true;
  }

  querySelectorAll(sel) {
    // supports comma groups and descendant combinators:
    // ".error h2, .error p"  /  ".track-item-details .title"
    const out = [];
    for (const group of sel.split(',')) {
      const parts = group.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      let pool = this.descendants();
      parts.forEach((part, i) => {
        const hit = pool.filter((el) => el.matches(part));
        pool = i === parts.length - 1 ? hit : hit.flatMap((el) => el.descendants());
      });
      for (const el of pool) if (!out.includes(el)) out.push(el);
    }
    return out;
  }

  closest(sel) {
    let node = this;
    while (node) {
      if (node.matches(sel)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  click() { if (this.onclick) this.onclick(); }
}

// One search page. `tracks` is [{ title, artist, behaviour }] where behaviour is
// 'ok' (resolves a stream) or 'fail' (the site's no-stream toast).
export function makePage(tracks, opts = {}) {
  const toastLingers = opts.toastLingers !== false; // real toasts stay up for seconds
  const anchorClicks = [];

  const notices = new El('div', { cls: [], text: '' });
  notices.attrs.id = 'download-notifications';
  notices.observers = [];

  const menuEntry = new El('li', { cls: [], attrs: { 'data-action': 'download' }, text: 'Download' });
  const menu = new El('div', { cls: [], children: [menuEntry] });
  menu.attrs.id = 'context-menu';

  let openCard = null;

  const cards = tracks.map((t) => {
    const title = new El('div', { cls: ['title'], text: t.title });
    const artist = new El('div', { cls: ['artist'], text: `${t.artist} • 2023` });
    const details = new El('div', { cls: ['track-item-details'], children: [title, artist] });
    const btn = new El('button', { cls: ['track-menu-btn'] });
    const card = new El('div', { cls: ['track-item'], children: [details, btn] });
    card.behaviour = t.behaviour;
    card.label = t.title;
    btn.onclick = () => { openCard = card; menu._display = 'block'; };
    return card;
  });

  menuEntry.onclick = () => {
    const card = openCard;
    if (!card) return;
    if (card.behaviour === 'ok') {
      const a = new HTMLAnchorElement();
      a.download = `${card.label}.flac`;
      a.click();
    } else {
      notices.innerText = `Couldn't download "${card.label}": no audio stream is available for this track`;
      if (!toastLingers) setTimeout(() => { notices.innerText = ''; }, 5);
    }
  };

  const container = new El('div', { cls: [], children: cards });
  container.attrs.id = 'search-tracks-container';

  const body = new El('body', { children: [container, menu, notices] });
  body.onclick = () => { menu._display = 'none'; openCard = null; };

  const byId = { 'search-tracks-container': container, 'context-menu': menu, 'download-notifications': notices };

  class HTMLAnchorElement {
    click() { anchorClicks.push(this.download); }
  }

  const document = {
    body,
    getElementById: (id) => byId[id] || null,
    dispatchEvent: () => {},
  };

  const MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(target) { (target.observers = target.observers || []).push(this.cb); }
    disconnect() {}
  };

  return {
    document,
    HTMLAnchorElement,
    MutationObserver,
    getComputedStyle: (el) => ({ display: el._display }),
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o); } },
    anchorClicks,
  };
}

// A Lucida page: either the search view (`results` given) or a release page
// (`downloadControl` given).
export function makeLucidaPage({ results = null, downloadControl = null, error = null, href = 'https://lucida.to/search?query=x' } = {}) {
  const children = [];

  if (error) {
    children.push(new El('div', { cls: ['error'], children: [new El('h2', { text: error })] }));
  } else if (results) {
    // The scaffold headings render even when the store has nothing, which is
    // what makes an empty result set look like a slow one.
    children.push(new El('h2', { text: 'Tracks' }));
    for (const r of results) {
      const link = new El('a', { attrs: { href: r.href } });
      const meta = new El('div', {
        cls: ['metadata'],
        children: [link, new El('h1', { text: r.title }), new El('h2', { text: r.artist })],
      });
      children.push(new El('div', { cls: ['search-result'], children: [meta] }));
    }
  }

  const clicked = [];
  if (downloadControl === 'button') {
    const btn = new El('button', { cls: ['download-button'], text: 'Download' });
    btn.onclick = () => clicked.push('download-button');
    children.push(btn);
  } else if (downloadControl === 'text') {
    const btn = new El('button', { text: 'Download track' });
    btn.onclick = () => clicked.push('text');
    children.push(btn);
  }

  const body = new El('body', { children });
  const location = { href };
  const document = {
    body,
    querySelector: (s) => body.querySelectorAll(s)[0] || null,
    querySelectorAll: (s) => body.querySelectorAll(s),
    getElementById: () => null,
    dispatchEvent: () => {},
  };
  return { document, location, clicked };
}

// Run a generated cascade script against a fake page, with timers compressed so
// a test that models minutes of polling finishes in milliseconds.
export function runScript(source, page, speedup = 50) {
  const scale = (ms) => Math.max(1, Math.round(ms / speedup));
  const fn = new Function(
    'document', 'HTMLAnchorElement', 'MutationObserver', 'getComputedStyle',
    'KeyboardEvent', 'setInterval', 'clearInterval', 'setTimeout', 'location',
    // Parenthesised because the source begins with a newline, and `return`
    // followed by a line break gets a semicolon inserted after it, yielding
    // undefined. The trailing `;` has to come off for the parens to wrap an
    // expression rather than a statement.
    `return (${source.trim().replace(/;$/, '')})`
  );
  return fn(
    page.document, page.HTMLAnchorElement, page.MutationObserver, page.getComputedStyle,
    page.KeyboardEvent,
    (f, ms) => setInterval(f, scale(ms)),
    clearInterval,
    (f, ms) => setTimeout(f, scale(ms)),
    page.location || { href: '' }
  );
}
