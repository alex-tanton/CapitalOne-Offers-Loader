// Pure data logic: extract and normalize feed tiles, filter, sort, build offer links. No DOM access, so it can be tested in Node.
(function (root) {
  'use strict';

  const REWARD_TYPES = {
    'percent':      '% back',
    'dollar-upto':  '$ back (up to)',
    'dollar-flat':  '$ back (flat)',
    'miles-rate':   'Earning rate',
    'miles-upto':   'Bonus miles (up to)',
    'miles-flat':   'Bonus miles (flat)',
    'other':        'Other'
  };

  // "Up to 5% back" -> 5, "Earn 2,500 miles" -> 2500, "9X miles" -> 9
  function parseRewardValue(text) {
    if (!text) return null;
    const m = String(text).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function classifyRewardType(text) {
    const t = (text || '').toLowerCase().replace(/,/g, '');
    const upTo = t.includes('up to');
    if (t.includes('%') && t.includes('back')) return 'percent';
    if (t.includes('$') && t.includes('back')) return upTo ? 'dollar-upto' : 'dollar-flat';
    if (/\d+\s*x\b/.test(t)) return 'miles-rate';
    if (t.includes('miles')) return upTo ? 'miles-upto' : 'miles-flat';
    return 'other';
  }

  // Only https links or same-site paths are ever used as a link target.
  function isSafeUrl(u) {
    return typeof u === 'string' && (/^https:\/\//i.test(u) || (u.startsWith('/') && !u.startsWith('//')));
  }

  function normalize(t, defaultType) {
    if (!t || !t.merchantTLD) return null;
    let reward = (t.buttonText || '').trim();
    if (t.rateText && (!reward || /^(shop now|learn more|view offer|redeem)/i.test(reward))) {
      reward = t.rateText.trim();
    }
    reward = reward || t.rateText || '';
    return {
      id: `${t.merchantTLD}::${reward}`,
      merchantTLD: t.merchantTLD,
      merchant: t.merchantDisplayName || t.merchantTLD,
      availability: t.text || 'Online',
      reward,
      rewardType: classifyRewardType(reward),
      rewardValue: parseRewardValue(reward),
      imageSrc: (t.imageSrc && String(t.imageSrc).startsWith('https://')) ? t.imageSrc : '',
      offerId: t.id || '',
      offers: t.offers || t.offerSources || null,
      kind: t.type || defaultType || 'Standard',
      redirectUrl: isSafeUrl(t.redirectUrl) ? t.redirectUrl : ''
    };
  }

  // The feed response holds plain tiles and carousels of tiles. Returns a flat list of normalized items.
  function extractItems(data) {
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const item of data) {
      if (!item) continue;
      if (item.type === 'Carousel' && Array.isArray(item.tiles)) {
        for (const sub of item.tiles) { const n = normalize(sub, 'Carousel'); if (n) out.push(n); }
      } else {
        const n = normalize(item, item.type);
        if (n) out.push(n);
      }
    }
    return out;
  }

  // The site's own offer id format, used when a tile does not carry one.
  function buildFeedOfferId(item, session) {
    if (!session) return '';
    const json = JSON.stringify({
      v: 1,
      viewContext: JSON.stringify({ id: session.viewInstanceId, org: 'capitaloneoffers', src: session.contentSlug, rwd: 'feed' }),
      inventory: { source: (item.kind || 'standard').toLowerCase(), merchantTLD: item.merchantTLD },
      offers: Array.isArray(item.offers) ? item.offers : ['affiliate']
    });
    return typeof btoa === 'function' ? btoa(json) : Buffer.from(json).toString('base64');
  }

  // The tile's own redirect if it has one, otherwise the offer detail page. Null means "click the site's own tile".
  function offerLink(item, session) {
    if (item.redirectUrl) return item.redirectUrl;
    if (session && session.arid) {
      const id = item.offerId || buildFeedOfferId(item, session);
      if (id) return `/feed/${encodeURIComponent(session.arid)}/offers/${id}`;
    }
    return null;
  }

  // ── Sorting ──────────────────────────────────────────────────────
  const by = (get, dir) => (a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;           // missing values always sort last
    if (y == null) return -1;
    return dir * (x - y);
  };

  const SORTS = {
    site:      { label: 'Site order',                  cmp: null },
    reward:    { label: 'Reward value, high to low',   cmp: by(i => i.rewardValue, -1) },
    rewardLow: { label: 'Reward value, low to high',   cmp: by(i => i.rewardValue, 1) },
    merchant:  { label: 'Merchant A to Z',             cmp: (a, b) => a.merchant.localeCompare(b.merchant) }
  };

  // ── Filtering ────────────────────────────────────────────────────
  // Empty lists mean "no restriction". Several values within one filter are OR'd; different filters are AND'd.
  const DEFAULT_FILTERS = {
    q: '', types: [], availability: [], merchants: [], minValue: null, onePerMerchant: false
  };

  function haystack(i) {
    return `${i.merchant} ${i.merchantTLD} ${i.availability} ${i.reward} ${REWARD_TYPES[i.rewardType] || ''}`.toLowerCase();
  }

  function matches(i, f) {
    if (f._types.size && !f._types.has(i.rewardType)) return false;
    if (f._avail.size && !f._avail.has(i.availability)) return false;
    if (f._merchants.size && !f._merchants.has(i.merchant)) return false;
    if (f.minValue != null && (i.rewardValue == null || i.rewardValue < f.minValue)) return false;
    if (f.q) {
      const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = haystack(i);
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  }

  function query(items, filters, sortKey) {
    const f = Object.assign({}, DEFAULT_FILTERS, filters);
    f._types = new Set(f.types); f._avail = new Set(f.availability); f._merchants = new Set(f.merchants);
    let out = items.filter(i => matches(i, f));
    const s = SORTS[sortKey];
    if (s && s.cmp) out = out.slice().sort(s.cmp);
    if (f.onePerMerchant) {
      const seen = new Set();
      out = out.filter(i => {
        if (seen.has(i.merchantTLD)) return false;
        seen.add(i.merchantTLD);
        return true;
      });
    }
    return out;
  }

  const api = {
    extractItems, normalize, query, offerLink, classifyRewardType, parseRewardValue,
    REWARD_TYPES, SORTS, DEFAULT_FILTERS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.C1O = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);