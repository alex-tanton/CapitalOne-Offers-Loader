(function () {
  'use strict';
  if (window.__c1oLoaded) return;
  window.__c1oLoaded = true;

  const { extractItems, query, offerLink, REWARD_TYPES, SORTS, DEFAULT_FILTERS } = globalThis.C1O;

  // This script runs in the page's own (MAIN) world so it can read the site's session state and
  // notice card switches. That world has no chrome.storage, so settings and cache use localStorage.

  // ── Configuration ──────────────────────────────────────────────────
  const STORE_SETTINGS = 'c1o_settings';
  const STORE_CACHE = 'c1o_cache';
  const DEFAULT_SETTINGS = {
    maxPages: 50,        // safety cap on pages requested
    delayMs: 1200,       // pause between page requests
    cacheMinutes: 60     // 0 turns the cache off
  };
  const MAX_RETRIES = 3;
  const COOLDOWN_MS = 30000;
  const DEFAULT_GRID_COLS = '5';
  const TILE_SELECTOR = '[data-testid^="feed-tile-"]';

  // ── State ──────────────────────────────────────────────────────────
  const S = {
    open: false,
    settings: { ...DEFAULT_SETTINGS },
    items: [],
    ids: new Set(),
    session: null,
    arid: null,          // the card whose offers are loaded
    loading: false,
    abort: null,
    loadedAt: null,
    status: '',
    error: '',
    filters: { ...DEFAULT_FILTERS },
    sort: 'site'
  };

  // ── Helpers ────────────────────────────────────────────────────────
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); });
  });

  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    down: 'M7 10l5 5 5-5z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z',
    tune: 'M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z'
  };
  function icon(name, size = 18) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name]); p.setAttribute('fill', 'currentColor');
    s.append(p);
    return s;
  }

  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' hr ago';
  }

  // ── Settings & cache (localStorage) ────────────────────────────────
  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_SETTINGS) || 'null');
      S.settings = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    } catch { /* keep defaults */ }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_SETTINGS, JSON.stringify(S.settings)); } catch {}
  }
  const cacheKey = arid => STORE_CACHE + (arid ? '_' + arid : '');
  function saveCache() {
    try { localStorage.setItem(cacheKey(S.arid), JSON.stringify({ ts: S.loadedAt, items: S.items, session: S.session })); } catch {}
  }
  function readCache(arid) {
    try {
      const r = JSON.parse(localStorage.getItem(cacheKey(arid)) || 'null');
      return r && Array.isArray(r.items) && r.items.length ? r : null;
    } catch { return null; }
  }

  // ── Session ────────────────────────────────────────────────────────
  // The feed needs the signed-in card id (arid) plus view details that the site keeps in its router state.
  function getSessionData() {
    try {
      const s = window.__reactRouterContext?.state?.loaderData?.root?.maybeUserSession ||
                window.__reactRouterDataRouter?.state?.loaderData?.root?.maybeUserSession ||
                window.__remixContext?.state?.loaderData?.root?.maybeUserSession;

      let arid = null;
      let viewInstanceId = s?.viewInstanceId;
      let contentSlug = s?.contentSlug;
      let cols = DEFAULT_GRID_COLS;

      // The newest feed request the site made tells us which card is selected and how it asked.
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const m = entries[i].name?.match(/\/feed\/([^/?#]+)/);
        if (!m) continue;
        const candidate = decodeURIComponent(m[1]);
        if (candidate === 'offers' || candidate.endsWith('.data')) continue;
        const url = new URL(entries[i].name);
        arid = candidate;
        viewInstanceId = url.searchParams.get('viewInstanceId') || viewInstanceId;
        contentSlug = url.searchParams.get('contentSlug') || url.searchParams.get('initialContentSlug') || contentSlug;
        cols = url.searchParams.get('numberOfColumnsInGrid') || cols;
        break;
      }

      arid = arid || s?.maybeSelectedArid || s?.arids?.[0];

      if (!viewInstanceId || !contentSlug) {
        const q = new URLSearchParams(window.location.search);
        viewInstanceId = viewInstanceId || q.get('viewInstanceId');
        contentSlug = contentSlug || q.get('contentSlug') || q.get('initialContentSlug');
        cols = q.get('numberOfColumnsInGrid') || cols;
      }

      return (arid && viewInstanceId && contentSlug)
        ? { arid, viewInstanceId, contentSlug, numberOfColumnsInGrid: cols }
        : null;
    } catch {
      return null;
    }
  }

  // ── Card switching ─────────────────────────────────────────────────
  // Each card has its own offers. When the site loads another card's feed, drop what we hold for the old one.
  function resetItems(arid) {
    S.arid = arid;
    S.items = [];
    S.ids = new Set();
    S.session = null;
    S.loadedAt = null;
    S.error = '';
    S.status = '';
  }

  function handleCardSwitch(arid) {
    if (!arid || arid === S.arid || S.loading) return;
    resetItems(arid);
    if (S.open) populate(); else scheduleRender();
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (...args) {
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      const m = url?.match(/\/feed\/([^/?#]+)/);
      if (m && m[1] !== 'offers' && !m[1].endsWith('.data')) handleCardSwitch(decodeURIComponent(m[1]));
    } catch {}
    return origFetch(...args);
  };

  // ── Feed requests ──────────────────────────────────────────────────
  async function fetchPage(session, cursor, signal) {
    const p = new URLSearchParams({
      numberOfColumnsInGrid: session.numberOfColumnsInGrid || DEFAULT_GRID_COLS,
      viewInstanceId: session.viewInstanceId,
      contentSlug: session.contentSlug
    });
    if (cursor) p.append('cursor', cursor);
    const url = `/feed/${encodeURIComponent(session.arid)}?${p}`;

    for (let attempt = 0; ; attempt++) {
      let resp;
      try {
        resp = await origFetch(url, { credentials: 'include', signal, headers: { Accept: '*/*' } });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error('Network error. Check your connection and try again.');
      }
      if (resp.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(resp.headers.get('Retry-After'), 10);
        const wait = retryAfter > 0 && retryAfter <= 60 ? retryAfter * 1000 : COOLDOWN_MS * (attempt + 1);
        setStatus(`Rate limited. Waiting ${Math.round(wait / 1000)}s before retrying…`);
        await sleep(wait, signal);
        continue;
      }
      return resp;
    }
  }

  function addItems(items) {
    let added = 0;
    for (const it of items) {
      if (S.ids.has(it.id)) continue;
      S.ids.add(it.id);
      S.items.push(it);
      added++;
    }
    return added;
  }

  async function loadAll() {
    if (S.loading) return;
    const session = getSessionData();
    if (!session) {
      S.error = 'Could not read your session. Reload the page and make sure you are signed in to Capital One Offers.';
      syncControls();
      return;
    }

    S.loading = true;
    S.error = '';
    S.items = [];
    S.ids = new Set();
    S.session = session;
    S.arid = session.arid;
    S.abort = new AbortController();
    const { signal } = S.abort;
    syncControls();

    let cursor = null;
    try {
      for (let page = 1; page <= S.settings.maxPages; page++) {
        setStatus(`Loading page ${page} of up to ${S.settings.maxPages}…`);
        const resp = await fetchPage(session, cursor, signal);

        if (resp.status === 429) {
          if (!S.items.length) throw new Error('Rate limit reached. Wait a moment and try again.');
          setStatus(`Rate limited. Showing the ${S.items.length} offers loaded so far.`);
          break;
        }
        if (resp.status === 401 || resp.status === 403) throw new Error('Session expired (' + resp.status + '). Reload the page, make sure you are signed in, and try again.');
        if (!resp.ok) throw new Error('Feed request failed with HTTP ' + resp.status + '.');

        const data = await resp.json().catch(() => { throw new Error('The feed returned an unexpected response.'); });
        addItems(extractItems(data.data));
        scheduleRender();

        const next = data.cursor;
        if (!next || next === cursor) break;
        cursor = next;
        await sleep(S.settings.delayMs, signal);
      }
      S.loadedAt = Date.now();
      if (!S.status.startsWith('Rate limited')) setStatus('');
    } catch (e) {
      if (e.name === 'AbortError') {
        S.loadedAt = Date.now();
        setStatus('Stopped.');
      } else {
        S.error = e.message || String(e);
        setStatus('');
      }
    } finally {
      S.loading = false;
      S.abort = null;
      if (S.items.length) saveCache();
      syncControls();
      scheduleRender();
    }
  }

  // Use the cache when it is fresh, otherwise load. Also notices when the site switched to another card.
  function populate() {
    if (S.loading) return;
    const session = getSessionData();
    if (session && session.arid !== S.arid) resetItems(session.arid);
    if (S.items.length) return;
    const c = readCache(S.arid);
    const fresh = c && (Date.now() - c.ts) < S.settings.cacheMinutes * 60000;
    if (fresh) {
      S.items = c.items; S.ids = new Set(c.items.map(i => i.id)); S.session = c.session || session; S.loadedAt = c.ts;
      scheduleRender();
    } else {
      loadAll();
    }
  }

  // Last resort for an offer with no link: press the site's own tile for that merchant.
  function openNative(item) {
    for (const el of document.querySelectorAll(TILE_SELECTOR)) {
      try {
        const data = JSON.parse(atob(el.dataset.testid.slice('feed-tile-'.length)));
        if (data.inventory?.merchantTLD === item.merchantTLD) {
          closeOverlay();
          el.click();
          return;
        }
      } catch {}
    }
    setStatus('Could not find this offer on the page. Reload the page and try again.');
  }

  // ── Multi-select dropdown (optionally searchable) ──────────────────
  const openMenus = new Set();
  function closeMenus(except) {
    let closed = false;
    for (const m of [...openMenus]) if (m !== except) { m.close(); closed = true; }
    return closed;
  }
  document.addEventListener('pointerdown', e => {
    const path = e.composedPath();
    for (const m of [...openMenus]) if (!path.includes(m.el)) m.close();
  }, true);

  function multiSelect({ label, searchable, allText, onChange }) {
    let options = [];                 // [{ value, text }]
    const selected = new Set();
    const rows = new Map();           // value -> { row, box }

    const valueEl = h('span', { class: 'of-value' });
    const trigger = h('button', { class: 'of-control', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, valueEl, icon('down', 20));
    const search = searchable ? h('input', { class: 'ms-search', type: 'search', placeholder: 'Search ' + label.toLowerCase(), 'aria-label': 'Search ' + label.toLowerCase(), oninput: filterRows }) : null;
    const clear = h('button', { class: 'btn text', type: 'button', text: 'Clear', onclick: () => { selected.clear(); syncRows(); onChange([]); } });
    const summary = h('span', { class: 'ms-summary' });
    const list = h('div', { class: 'ms-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': label });
    const menu = h('div', { class: 'ms-menu' },
      search ? h('div', { class: 'ms-searchwrap' }, icon('search', 18), search) : null,
      list,
      h('div', { class: 'ms-foot' }, summary, clear));
    const el = h('div', { class: 'of ms' }, h('span', { class: 'of-label', text: label }), trigger, menu);

    const api = { el, open, close, setOptions, setSelected };
    trigger.addEventListener('click', () => (el.classList.contains('open') ? close() : open()));

    function open() {
      closeMenus(api);
      el.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      openMenus.add(api);
      if (search) { search.value = ''; filterRows(); setTimeout(() => search.focus(), 0); }
    }
    function close() {
      el.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      openMenus.delete(api);
    }

    function filterRows() {
      const q = search ? search.value.trim().toLowerCase() : '';
      let visible = 0;
      for (const o of options) {
        const r = rows.get(o.value);
        const show = !q || o.text.toLowerCase().includes(q);
        r.row.style.display = show ? '' : 'none';
        if (show) visible++;
      }
      list.dataset.empty = visible === 0 ? 'true' : 'false';
    }

    function syncRows() {
      for (const o of options) rows.get(o.value).box.checked = selected.has(o.value);
      const n = selected.size;
      const only = n === 1 ? options.find(o => selected.has(o.value)) : null;
      valueEl.textContent = n === 0 ? allText : n === 1 ? (only ? only.text : [...selected][0]) : n + ' selected';
      valueEl.classList.toggle('placeholder', n === 0);
      summary.textContent = n ? n + ' selected' : '';
      clear.disabled = n === 0;
    }

    function setOptions(next) {
      options = next;
      rows.clear();
      list.replaceChildren(...options.map(o => {
        const box = h('input', { type: 'checkbox', onchange: () => {
          if (box.checked) selected.add(o.value); else selected.delete(o.value);
          syncRows(); onChange([...selected]);
        } });
        const row = h('label', { class: 'ms-row', role: 'option' }, box, h('span', { text: o.text }));
        rows.set(o.value, { row, box });
        return row;
      }));
      syncRows();
      filterRows();
    }

    function setSelected(values) {
      selected.clear();
      values.forEach(v => selected.add(v));
      syncRows();
    }

    setOptions([]);
    return api;
  }

  // ── UI scaffold (Shadow DOM keeps our styles away from the site) ───
  const host = h('div', { id: 'c1o-host' });
  const root = host.attachShadow({ mode: 'open' });
  const R = {};   // element refs

  // Material Design 3 tokens: color roles, shape and type scale
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui {
      --primary: #0b5fa5; --on-primary: #ffffff;
      --primary-container: #d3e4ff; --on-primary-container: #001c38;
      --secondary-container: #d8e3f3; --on-secondary-container: #111c2b;
      --tertiary: #36695a; --tertiary-container: #dce8e1; --on-tertiary-container: #14291f;
      --error-container: #ffdad6; --on-error-container: #410002;
      --surface: #f8f9fe; --surface-low: #f2f3f9; --surface-container: #ecedf3; --surface-high: #e6e8ee;
      --on-surface: #191c20; --on-surface-variant: #43474e;
      --outline: #73777f; --outline-variant: #c3c7cf;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 2px 6px 2px rgba(0,0,0,.15);
      --shadow-3: 0 1px 3px rgba(0,0,0,.3), 0 4px 8px 3px rgba(0,0,0,.15);
      font: 400 14px/20px Roboto, "Google Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: .01em;
      color: var(--on-surface);
    }
    button, input, select { font: inherit; letter-spacing: inherit; color: inherit; }
    :focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }

    /* State layer (hover / pressed), as in M3 */
    .btn, .chip, .fab, .icon-btn, .ms-row { position: relative; overflow: hidden; }
    .btn::before, .chip::before, .fab::before, .icon-btn::before {
      content: ''; position: absolute; inset: 0; background: currentColor; opacity: 0; transition: opacity .15s;
    }
    .btn:hover::before, .chip:hover::before, .fab:hover::before, .icon-btn:hover::before { opacity: .08; }
    .btn:active::before, .chip:active::before, .fab:active::before, .icon-btn:active::before { opacity: .12; }
    @media (prefers-reduced-motion: reduce) { .btn::before, .chip::before { transition: none; } }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 24px;
      border-radius: 20px; border: 0; background: transparent; font-weight: 500; cursor: pointer; white-space: nowrap;
    }
    .btn.filled { background: var(--primary); color: var(--on-primary); }
    .btn.tonal { background: var(--secondary-container); color: var(--on-secondary-container); }
    .btn.outlined { border: 1px solid var(--outline); color: var(--primary); }
    .btn.text { color: var(--primary); padding: 0 12px; }
    .btn[disabled] { cursor: default; opacity: .38; }
    .btn[disabled]::before { display: none; }
    .btn.filled[disabled], .btn.tonal[disabled] { background: color-mix(in srgb, var(--on-surface) 12%, transparent); color: var(--on-surface); opacity: .6; }
    .icon-btn {
      display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 0;
      border-radius: 50%; background: transparent; color: var(--on-surface-variant); cursor: pointer;
    }
    .fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; height: 56px; padding: 0 20px; border: 0;
      border-radius: 16px; background: var(--primary-container); color: var(--on-primary-container);
      font-weight: 500; font-size: 14px; cursor: pointer; box-shadow: var(--shadow-3);
      display: inline-flex; align-items: center; gap: 12px;
    }

    /* Surface */
    .overlay { position: fixed; inset: 0; z-index: 2147483001; background: var(--surface); display: none; flex-direction: column; }
    .overlay.open { display: flex; }
    .appbar { display: flex; align-items: center; gap: 8px; min-height: 64px; padding: 8px 12px 8px 20px; background: var(--surface-container); flex-wrap: wrap; }
    .titles { margin-right: auto; display: flex; flex-direction: column; min-width: 0; }
    .titles h1 { margin: 0; font: 400 22px/28px Roboto, "Google Sans", ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; }
    .count { font-size: 12px; line-height: 16px; color: var(--on-surface-variant); font-variant-numeric: tabular-nums; }

    /* Filters */
    .tools { position: relative; z-index: 5; padding: 20px 20px 12px; display: grid; gap: 16px; background: var(--surface); }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .filters { flex-wrap: nowrap; }
    .of { position: relative; flex: 0 1 170px; min-width: 120px; }
    .of.grow { flex: 1 1 200px; min-width: 150px; }
    .of.sort { flex: 0 0 220px; }
    .of.narrow { flex: 0 0 132px; min-width: 100px; }
    .settings .of.narrow { flex: 0 0 120px; }
    @media (max-width: 1200px) { .filters { flex-wrap: wrap; } .of { flex-basis: 170px; } .of.grow { flex-basis: 220px; } }
    .of-label {
      position: absolute; top: -8px; left: 12px; padding: 0 4px; background: var(--surface); z-index: 1;
      font-size: 12px; line-height: 16px; color: var(--on-surface-variant); pointer-events: none;
    }
    .of:focus-within > .of-label, .of.open > .of-label { color: var(--primary); }
    .of input[type=text], .of input[type=number], .of input.field, .of select, .of-control {
      width: 100%; height: 48px; padding: 0 12px; border: 1px solid var(--outline); border-radius: 4px;
      background: transparent; color: var(--on-surface); text-align: left;
    }
    .of input.field.lead { padding-left: 40px; }
    .of .lead-icon { position: absolute; left: 12px; top: 14px; color: var(--on-surface-variant); pointer-events: none; }
    .of:focus-within input, .of:focus-within select, .of.open .of-control { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); outline: none; }
    .of input:hover:not(:focus), .of select:hover:not(:focus), .of-control:hover { border-color: var(--on-surface); }
    .of select { appearance: none; padding-right: 36px; cursor: pointer; }
    .of select option { background: var(--surface); color: var(--on-surface); }
    .of .chev { position: absolute; right: 10px; top: 14px; pointer-events: none; color: var(--on-surface-variant); }
    .of-control { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
    .of-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .of-value.placeholder { color: var(--on-surface-variant); }

    .ms-menu {
      display: none; position: absolute; top: calc(100% + 4px); left: 0; min-width: 100%; width: max-content; max-width: 340px;
      background: var(--surface-container); border-radius: 4px; box-shadow: var(--shadow-3); z-index: 20; padding: 8px 0 0;
    }
    .of.open .ms-menu { display: block; }
    .ms-searchwrap { display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 0 12px; height: 40px; border-radius: 20px; background: var(--surface-high); color: var(--on-surface-variant); }
    .ms-search { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--on-surface); height: 100%; }
    .ms-list { max-height: 280px; overflow-y: auto; padding: 4px 0; min-width: 200px; }
    .ms-list[data-empty="true"]::after { content: 'No matches'; display: block; padding: 12px 16px; color: var(--on-surface-variant); }
    .ms-row { display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 44px; cursor: pointer; }
    .ms-row:hover { background: color-mix(in srgb, var(--on-surface) 8%, transparent); }
    .ms-row input { width: 18px; height: 18px; margin: 0; accent-color: var(--primary); flex: none; }
    .ms-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ms-foot { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 4px 16px; border-top: 1px solid var(--outline-variant); }
    .ms-summary { color: var(--on-surface-variant); font-size: 12px; }

    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip {
      display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--outline); background: transparent; color: var(--on-surface-variant); font-weight: 500;
    }
    .chip[aria-pressed="true"] { background: var(--secondary-container); color: var(--on-secondary-container); border-color: transparent; padding-left: 8px; }
    .chip.toggle { margin-left: 8px; }
    .chip small { font-size: 12px; font-weight: 400; opacity: .8; font-variant-numeric: tabular-nums; }

    .settings { display: none; gap: 12px; flex-wrap: wrap; align-items: center; padding: 16px; border-radius: 12px; background: var(--surface-low); }
    .settings.open { display: flex; }
    .settings .of-label { background: var(--surface-low); }

    .notice { margin: 0 20px 8px; padding: 12px 16px; border-radius: 12px; background: var(--secondary-container); color: var(--on-secondary-container); }
    .notice.err { background: var(--error-container); color: var(--on-error-container); }
    .progress { height: 4px; background: var(--secondary-container); overflow: hidden; }
    .progress > i { display: block; height: 100%; width: 35%; background: var(--primary); border-radius: 2px; animation: slide 1.2s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce) { .progress > i { animation: none; width: 100%; } }
    @keyframes slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }

    /* Cards (outlined card, M3) */
    main { flex: 1; overflow-y: auto; padding: 8px 20px 48px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
    .card {
      display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 12px;
      background: var(--surface); border: 1px solid var(--outline-variant);
      content-visibility: auto; contain-intrinsic-size: auto 200px;
    }
    .card:hover { background: var(--surface-low); }
    .head { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .logo { width: 48px; height: 48px; flex: none; border-radius: 8px; object-fit: contain; background: #ffffff; border: 1px solid var(--outline-variant); }
    .logo.ph { display: flex; align-items: center; justify-content: center; font: 500 20px/24px Roboto, "Google Sans", ui-sans-serif, system-ui, sans-serif; background: var(--surface-container); color: var(--on-surface-variant); }
    .names { min-width: 0; }
    .merchant { font: 500 16px/24px Roboto, "Google Sans", ui-sans-serif, system-ui, sans-serif; letter-spacing: .01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .supporting { font-size: 12px; line-height: 16px; color: var(--on-surface-variant); }
    .reward { display: flex; flex-direction: column; gap: 2px; padding: 12px 16px; border-radius: 12px; background: var(--tertiary-container); color: var(--on-tertiary-container); }
    .reward .big { font: 500 22px/28px Roboto, "Google Sans", ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; }
    .reward .detail { font-size: 12px; line-height: 16px; opacity: .85; }
    .card .btn { margin-top: auto; text-decoration: none; width: 100%; }
    .empty { text-align: center; color: var(--on-surface-variant); padding: 64px 0; grid-column: 1 / -1; }
    @media (max-width: 640px) { .tools, main { padding-left: 12px; padding-right: 12px; } .notice { margin-left: 12px; margin-right: 12px; } .appbar { padding-left: 16px; } }
  `;

  function outlined(label, control, cls = '') {
    return h('div', { class: 'of ' + cls }, h('span', { class: 'of-label', text: label }), control);
  }

  function buildUI() {
    R.launcher = h('button', { class: 'fab', onclick: openOverlay }, icon('tune', 20), 'Offers explorer');

    R.count = h('span', { class: 'count' });
    R.reload = h('button', { class: 'btn filled', onclick: () => loadAll() }, icon('refresh', 18), 'Reload offers');
    R.stop = h('button', { class: 'btn outlined', text: 'Stop', onclick: () => S.abort && S.abort.abort() });
    R.gear = h('button', { class: 'btn text', text: 'Settings', onclick: () => R.settings.classList.toggle('open') });
    R.close = h('button', { class: 'icon-btn', 'aria-label': 'Close', title: 'Close', onclick: closeOverlay }, icon('close', 24));

    R.q = h('input', { class: 'field lead', type: 'text', autocomplete: 'off', placeholder: 'Merchant or keyword', oninput: e => setFilter({ q: e.target.value }) });
    R.sort = h('select', { onchange: e => { S.sort = e.target.value; scheduleRender(); } },
      Object.entries(SORTS).map(([k, v]) => h('option', { value: k, text: v.label })));

    R.avail = multiSelect({ label: 'Availability', allText: 'All', onChange: v => setFilter({ availability: v }) });
    R.availKey = '';
    R.merchant = multiSelect({ label: 'Merchant', allText: 'All merchants', searchable: true, onChange: v => setFilter({ merchants: v }) });
    R.merchantKey = '';

    R.minValue = h('input', { class: 'field', type: 'number', min: '0', step: '1', placeholder: 'Any', oninput: e => setFilter({ minValue: e.target.value === '' ? null : +e.target.value }) });
    R.chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Reward types' });

    const mk = (label, val, min, max, step) => {
      const input = h('input', { type: 'number', min, max, step, value: val });
      return { el: outlined(label, input, 'narrow'), input };
    };
    R.setPages = mk('Max pages', S.settings.maxPages, 1, 500, 1);
    R.setDelay = mk('Delay (ms)', S.settings.delayMs, 200, 10000, 100);
    R.setCache = mk('Cache (min)', S.settings.cacheMinutes, 0, 1440, 5);
    R.settings = h('div', { class: 'settings' }, R.setPages.el, R.setDelay.el, R.setCache.el,
      h('button', { class: 'btn filled', text: 'Save settings', onclick: applySettings }));

    R.notice = h('div', { class: 'notice', style: 'display:none' });
    R.progress = h('div', { class: 'progress', style: 'display:none' }, h('i'));
    R.grid = h('div', { class: 'grid' });
    R.main = h('main', {}, R.grid);

    R.onePer = h('button', { class: 'chip toggle', type: 'button', 'aria-pressed': 'false', onclick: () => setFilter({ onePerMerchant: !S.filters.onePerMerchant }) });

    const tools = h('section', { class: 'tools' },
      h('div', { class: 'row filters' },
        h('div', { class: 'of grow' }, h('span', { class: 'of-label', text: 'Search' }), h('span', { class: 'lead-icon' }, icon('search', 20)), R.q),
        h('div', { class: 'of sort' }, h('span', { class: 'of-label', text: 'Sort by' }), R.sort, h('span', { class: 'chev' }, icon('down', 20))),
        R.avail.el, R.merchant.el,
        outlined('Min reward value', R.minValue, 'narrow')),
      R.chips,
      R.settings);

    R.overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-label': 'Capital One Offers' },
      h('header', { class: 'appbar' },
        h('div', { class: 'titles' }, h('h1', { text: 'Capital One Offers' }), R.count),
        R.reload, R.stop, R.gear, R.close),
      tools, R.notice, R.progress, R.main);

    root.append(h('style', { text: CSS }), h('div', { class: 'ui' }, R.launcher, R.overlay));
  }

  // ── Actions ────────────────────────────────────────────────────────
  function setStatus(msg) { S.status = msg; syncNotice(); }

  function setFilter(patch) {
    Object.assign(S.filters, patch);
    scheduleRender();
  }

  function applySettings() {
    const clamp = (v, lo, hi, d) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    S.settings.maxPages = clamp(R.setPages.input.value, 1, 500, DEFAULT_SETTINGS.maxPages);
    S.settings.delayMs = clamp(R.setDelay.input.value, 200, 10000, DEFAULT_SETTINGS.delayMs);
    S.settings.cacheMinutes = clamp(R.setCache.input.value, 0, 1440, DEFAULT_SETTINGS.cacheMinutes);
    saveSettings();
    R.settings.classList.remove('open');
    setStatus('Settings saved. Reload offers to apply them.');
  }

  function openOverlay() {
    S.open = true;
    R.overlay.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    R.q.focus();
    populate();
    scheduleRender();
  }

  function closeOverlay() {
    closeMenus();
    S.open = false;
    R.overlay.classList.remove('open');
    document.documentElement.style.overflow = '';
  }

  // ── Rendering ──────────────────────────────────────────────────────
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
  }

  function syncControls() {
    if (!R.overlay) return;
    R.reload.disabled = S.loading;
    R.stop.disabled = !S.loading;
    R.progress.style.display = S.loading ? 'block' : 'none';
    syncNotice();
  }

  function syncNotice() {
    if (!R.overlay) return;
    const stale = S.loadedAt && !S.loading && (Date.now() - S.loadedAt) > S.settings.cacheMinutes * 60000;
    const msg = S.error || S.status ||
      (stale ? 'These offers were loaded ' + ago(S.loadedAt) + '. Reload to refresh the links.' : '');
    R.notice.textContent = msg;
    R.notice.className = 'notice' + (S.error ? ' err' : '');
    R.notice.style.display = msg ? 'block' : 'none';
  }

  function refreshOptions() {
    // Reward-type chips: toggle several at once; counts reflect every other active filter.
    const base = query(S.items, { ...S.filters, types: [] }, 'site');
    const counts = new Map();
    for (const i of base) counts.set(i.rewardType, (counts.get(i.rewardType) || 0) + 1);
    const present = new Set(S.items.map(i => i.rewardType));
    const types = Object.keys(REWARD_TYPES).filter(t => present.has(t));
    R.chips.replaceChildren(
      chip(null, 'All', base.length),
      ...types.map(t => chip(t, REWARD_TYPES[t], counts.get(t) || 0)),
      R.onePer);

    R.onePer.replaceChildren(S.filters.onePerMerchant ? icon('check', 18) : '', 'One offer per merchant');
    R.onePer.setAttribute('aria-pressed', String(S.filters.onePerMerchant));

    // Dropdown options only change when new values arrive, so an open menu keeps its scroll and search.
    const avail = [...new Set(S.items.map(i => i.availability))].sort((a, b) => a.localeCompare(b));
    const availKey = avail.join('\u0001');
    if (availKey !== R.availKey) {
      R.availKey = availKey;
      R.avail.setOptions(avail.map(a => ({ value: a, text: a })));
      R.avail.setSelected(S.filters.availability);
    }
    const merchants = [...new Set(S.items.map(i => i.merchant))].sort((a, b) => a.localeCompare(b));
    const key = merchants.join('\u0001');
    if (key !== R.merchantKey) {
      R.merchantKey = key;
      R.merchant.setOptions(merchants.map(m => ({ value: m, text: m })));
      R.merchant.setSelected(S.filters.merchants);
    }
  }

  function chip(value, text, n) {
    const on = value === null ? S.filters.types.length === 0 : S.filters.types.includes(value);
    return h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(on),
      onclick: () => {
        if (value === null) return setFilter({ types: [] });
        const cur = S.filters.types;
        setFilter({ types: cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value] });
      }
    }, on ? icon('check', 18) : '', text, h('small', { text: String(n) }));
  }

  function card(i) {
    const href = offerLink(i, S.session);
    const logo = i.imageSrc
      ? h('img', { class: 'logo', src: i.imageSrc, alt: '', loading: 'lazy' })
      : h('div', { class: 'logo ph', text: (i.merchant[0] || '?').toUpperCase() });
    const action = href
      ? h('a', { class: 'btn filled', href, target: '_blank', rel: 'noopener noreferrer', text: 'View offer' })
      : h('button', { class: 'btn filled', type: 'button', text: 'View offer', onclick: () => openNative(i) });

    return h('article', { class: 'card' },
      h('div', { class: 'head' },
        logo,
        h('div', { class: 'names' },
          h('div', { class: 'merchant', text: i.merchant, title: i.merchant }),
          h('div', { class: 'supporting', text: i.availability }))),
      h('div', { class: 'reward' },
        h('div', { class: 'big', text: i.reward || 'See offer details' }),
        h('div', { class: 'detail', text: REWARD_TYPES[i.rewardType] })),
      action);
  }

  function render() {
    if (!R.overlay) return;
    syncControls();
    if (!S.open) return;
    refreshOptions();
    const res = query(S.items, S.filters, S.sort);
    R.count.textContent = S.items.length
      ? `${res.length.toLocaleString()} of ${S.items.length.toLocaleString()} offers` + (S.loadedAt ? ' · loaded ' + ago(S.loadedAt) : '')
      : '';

    if (res.length === 0) {
      R.grid.replaceChildren(h('div', { class: 'empty', text: S.loading ? 'Loading offers…' : S.items.length ? 'No offers match these filters. Remove a filter to see more.' : 'No offers loaded yet. Select Reload offers.' }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const i of res) frag.append(card(i));
    R.grid.replaceChildren(frag);
  }

  // ── Lifecycle: only active on the feed (not on an offer's detail page) ──
  function onFeed() { return location.pathname.startsWith('/feed') && !location.pathname.includes('/offers/'); }

  function syncVisibility() {
    const show = onFeed();
    host.style.display = show ? '' : 'none';
    if (!show && S.open) closeOverlay();
  }

  function init() {
    loadSettings();
    buildUI();
    document.documentElement.append(host);
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !S.open) return;
      if (!closeMenus()) closeOverlay();   // close an open dropdown first
    });
    const session = getSessionData();
    if (session) S.arid = session.arid;
    syncVisibility();
    setInterval(syncVisibility, 700);   // the site is a single-page app, so watch for route changes
    syncControls();
  }

  init();
})();