// ==UserScript==
// @name         MAL Forum Vote Counter (Viewer)
// @namespace    https://myanimelist.net/
// @version      0.1
// @description  Reads a MAL voting thread and shows the matchup results. No exports.
// @match        https://myanimelist.net/forum/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  const topicId = (new URLSearchParams(location.search)).get('topicid');
  if (!topicId) return; // only run inside a topic

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */
  const KEY = 'mvu_topic_' + topicId;
  const loadState = () => {
    let s = null;
    try { s = JSON.parse(GM_getValue(KEY, '')); } catch (e) { /* ignore */ }
    s = s || {};
    return { matchups: s.matchups || null, posts: s.posts || {}, range: s.range || { from: null, to: null } };
  };
  const saveState = (s) => GM_setValue(KEY, JSON.stringify(s));
  const getSetting = (k, d) => GM_getValue('mvc_setting_' + k, d);
  const setSetting = (k, v) => GM_setValue('mvc_setting_' + k, v);

  /* ------------------------------------------------------------------ *
   * Python difflib port (SequenceMatcher.ratio / get_close_matches)
   * ------------------------------------------------------------------ */
  function matchedChars(a, b) {
    function longest(alo, ahi, blo, bhi) {
      let bi = alo, bj = blo, bk = 0;
      let prev = new Array(b.length + 1).fill(0);
      for (let i = alo; i < ahi; i++) {
        const cur = new Array(b.length + 1).fill(0);
        for (let j = blo; j < bhi; j++) {
          if (a[i] === b[j]) {
            const k = prev[j] + 1; // prev[j] == length ending at (i-1, j-1)
            cur[j + 1] = k;
            if (k > bk) { bi = i - k + 1; bj = j - k + 1; bk = k; }
          }
        }
        prev = cur;
      }
      return [bi, bj, bk];
    }
    function rec(alo, ahi, blo, bhi) {
      if (alo >= ahi || blo >= bhi) return 0;
      const [i, j, k] = longest(alo, ahi, blo, bhi);
      if (!k) return 0;
      return k + rec(alo, i, blo, j) + rec(i + k, ahi, j + k, bhi);
    }
    return rec(0, a.length, 0, b.length);
  }
  function ratio(a, b) {
    const t = a.length + b.length;
    return t ? (2 * matchedChars(a, b)) / t : 1;
  }
  function closeMatch(word, possibilities, cutoff) {
    let best = null, bestScore = -1;
    for (const x of possibilities) {
      const s = ratio(x, word);
      if (s >= cutoff && (s > bestScore || (s === bestScore && x > best))) { best = x; bestScore = s; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * Reading the page
   * ------------------------------------------------------------------ */
  function getMessages(root) {
    return [...root.querySelectorAll('[id^="message"]')]
      .filter(e => /^message\d+$/.test(e.id))
      .map(el => ({ id: el.id.replace('message', ''), el }));
  }

  function findUser(el) {
    const sel = '[id^="message"]';
    let container = el, p = el.parentElement;
    while (p) {
      const n = [...p.querySelectorAll(sel)].filter(e => /^message\d+$/.test(e.id)).length;
      if (n > 1) break;
      container = p; p = p.parentElement;
    }
    const links = [...container.querySelectorAll('a[href*="/profile/"]')].filter(a => !el.contains(a));
    if (!links.length) return 'Unknown';
    const a = links.find(l => l.closest('.forum_username, .forum-username')) || links[0];
    const txt = (a.textContent || '').trim();
    if (txt) return txt;
    const m = a.getAttribute('href').match(/\/profile\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : 'Unknown';
  }

  // Turns a post body into clean text lines (quotes removed, <br> = newline).
  function extractLines(root, skipSpoilers) {
    const out = []; let cur = '';
    const flush = () => { out.push(cur); cur = ''; };
    const BLOCK = /^(DIV|P|LI|UL|OL|TABLE|TR|H\d|BLOCKQUOTE|PRE)$/;
    (function walk(n) {
      if (n.nodeType === 3) { cur += n.nodeValue.replace(/[\s\u00a0]+/g, ' '); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (/^(SCRIPT|STYLE|INPUT|BUTTON|IMG|TEXTAREA)$/.test(tag)) return;
      if (n.matches && n.matches('.quotetext, blockquote, .mvc-badge')) return;
      if (skipSpoilers && n !== root) {
        const st = (n.getAttribute('style') || '').replace(/\s/g, '');
        if (n.classList.contains('spoiler_content') || /display:none/.test(st)) return;
      }
      if (tag === 'BR') { flush(); return; }
      const block = BLOCK.test(tag);
      if (block) flush();
      n.childNodes.forEach(walk);
      if (block) flush();
    })(root);
    flush();
    return out.join('\n').split('\n').map(s => s.trim()).filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * Matchups (from the #1 post, "Give your vote" section)
   * ------------------------------------------------------------------ */
  function parseMatchups(el) {
    let lines = extractLines(el, true);
    let start = -1;
    lines.forEach((l, i) => { if (/give your vote/i.test(l)) start = i; });
    if (start >= 0) lines = lines.slice(start + 1);

    const numRe = /^\s*(\d+)[.)]\s*(.+)$/;
    const splitRe = /\s+(?:v|vs)\.?\s+/i;
    const sections = [];
    let cur = null, lastText = null, lastNum = 0;

    for (const line of lines) {
      const m = line.match(numRe);
      const parts = m ? m[2].split(splitRe) : null;
      if (m && parts.length >= 2) {
        const num = m[1];
        const [p1, ...rest] = parts;
        const p2 = rest.join(' v ');
        if (!cur || parseInt(num, 10) <= lastNum) {
          let name = 'Matchups';
          if (lastText && lastText.length <= 25 && !/[:\d]/.test(lastText)) name = lastText;
          cur = { name, items: [] };
          sections.push(cur);
        }
        lastNum = parseInt(num, 10);
        cur.items.push({ num, p1: p1.trim(), p2: p2.trim() });
        lastText = null;
      } else {
        lastText = line.replace(/[\[\]*:_-]+/g, ' ').trim();
      }
    }
    return sections.length ? { sections } : null;
  }

  async function fetchPageOneMatchups() {
    const r = await fetch(`/forum/?topicid=${topicId}`, { credentials: 'same-origin' });
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    for (const m of getMessages(doc)) {
      if (/give your vote/i.test(m.el.textContent)) {
        const mu = parseMatchups(m.el);
        if (mu) return mu;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Counting (same logic as EventMang 0.1 count_votes)
   * ------------------------------------------------------------------ */
  function countAll(state) {
    const mu = state.matchups;
    const secMaps = {};            // section -> {num: [p1,p2]}
    const lookup = new Map();      // lowercase title -> {title, section, num}
    const allTitles = [];
    for (const s of mu.sections) {
      secMaps[s.name] = {};
      for (const it of s.items) {
        secMaps[s.name][it.num] = [it.p1, it.p2];
        for (const t of [it.p1, it.p2]) {
          lookup.set(t.toLowerCase(), { title: t, section: s.name, num: it.num });
          allTitles.push(t);
        }
      }
    }
    const secNames = mu.sections.map(s => s.name);
    const secLower = Object.fromEntries(secNames.map(n => [n.toLowerCase(), n]));
    const multi = secNames.length > 1;

    const votes = {};
    const records = [];            // one per vote line
    const q = { lines: 0, valid: 0, empty: 0, misspelled: 0, ignored: 0, assumed: 0 };
    const voters = new Set();

    const { from, to } = state.range || {};
    const hasRange = from != null || to != null;
    const allPosts = Object.entries(state.posts);
    const posts = allPosts
      .filter(([, p]) => !hasRange || (p.num != null && (from == null || p.num >= from) && (to == null || p.num <= to)))
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    for (const [postId, post] of posts) {
      if (!post.lines.length) {
        q.empty++;
        records.push({ user: post.user, postId, lineNo: '', raw: '', section: '', num: '', pick: '', status: 'Empty post', note: '' });
        continue;
      }
      let curSec = null;
      post.lines.forEach((raw, idx) => {
        const l = raw.trim();
        const lineNo = idx + 1;
        const norm = l.replace(/[\[\]*:_\-–—]+/g, ' ').trim().toLowerCase();
        if (multi && secLower[norm]) { curSec = secLower[norm]; return; }

        q.lines++;
        const rec = { user: post.user, postId, lineNo, raw, section: '', num: '', pick: '', status: '', note: '' };
        records.push(rec);
        const count = (title, section, num, note) => {
          votes[title] = (votes[title] || 0) + 1;
          q.valid++; voters.add(post.user);
          Object.assign(rec, { section, num, pick: title, status: 'Counted', note: note || '' });
        };

        // CASE A: "1. Title"
        const m = l.match(/^(\d+)\.\s*(.+)/);
        if (m) {
          const num = m[1], pick = m[2].trim();
          // With a section header use that section; without one, try every section that has this number.
          const cands = curSec ? [curSec] : secNames.filter(n => secMaps[n][num]);
          const noteFor = sec => (!curSec && cands.length > 1) ? `No section header - matched to "${sec}"` : '';
          let done = false;
          for (const sec of cands) {
            const options = secMaps[sec][num] || [];
            const found = options.find(o => pick.toLowerCase().includes(o.toLowerCase()));
            if (found) { const nt = noteFor(sec); if (nt) q.assumed++; count(found, sec, num, nt); done = true; break; }
          }
          if (done) return;
          for (const sec of cands) {
            const options = secMaps[sec][num] || [];
            const guess = options.length ? closeMatch(pick, options, 0.6) : null;
            if (guess) {
              q.misspelled++;
              Object.assign(rec, { section: sec, num, status: 'Misspelled', note: `Did you mean "${guess}"?` + noteFor(sec) });
              return;
            }
          }
          q.ignored++; Object.assign(rec, { status: 'Ignored' });
          return;
        }

        // CASE B: free text (substring match against any title)
        const low = l.toLowerCase();
        for (const [key, info] of lookup) {
          if (low.includes(key)) { count(info.title, info.section, info.num); return; }
        }
        const guess = closeMatch(l, allTitles, 0.75);
        if (guess) {
          q.misspelled++;
          Object.assign(rec, { status: 'Misspelled', note: `Did you mean "${guess}"?` });
        } else {
          q.ignored++; Object.assign(rec, { status: 'Ignored' });
        }
      });
    }

    const sections = mu.sections.map(s => ({
      name: s.name,
      matchups: s.items.map(it => {
        const v1 = votes[it.p1] || 0, v2 = votes[it.p2] || 0;
        return { num: it.num, p1: it.p1, p2: it.p2, v1, v2, winner: v1 > v2 ? it.p1 : v2 > v1 ? it.p2 : null };
      })
    }));
    return { sections, records, quality: q, voterCount: voters.size, postCount: posts.length,
      totalStored: allPosts.length, from, to };
  }

  /* ------------------------------------------------------------------ *
   * UI (results only)
   * ------------------------------------------------------------------ */
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e[k] = v;
    }
    kids.flat().forEach(c => { if (c != null) e.append(c); });
    return e;
  };

  const css = document.createElement('style');
  css.textContent = `
    #mvu{--bg:#171717;--bg2:#222;--fg:#ddd;--bd:#444;--btn:#2b2b2b;--btnh:#3a3a3a;--btnfg:#eee;--inp:#111;
      --dot:#2c2c2c;--win:#6fdc6f;--lose:#aaa;--tie:#e8c34a;--st:#9ab;--err:#ff7777;--sh:rgba(0,0,0,.6)}
    #mvu.light{--bg:#fff;--bg2:#f0f0f0;--fg:#222;--bd:#c8c8c8;--btn:#f5f5f5;--btnh:#e4e4e4;--btnfg:#222;--inp:#fff;
      --dot:#ddd;--win:#1a7f1a;--lose:#777;--tie:#a67c00;--st:#456;--err:#c00;--sh:rgba(0,0,0,.25)}
    #mvu{position:fixed;right:14px;bottom:14px;width:320px;max-height:80vh;overflow:auto;z-index:99999;
      background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:8px;font:13px/1.4 Arial,sans-serif;
      box-shadow:0 4px 18px var(--sh)}
    #mvu .hd{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--bg2);
      border-bottom:1px solid var(--bd);font-weight:bold;cursor:pointer}
    #mvu .bd{padding:10px}
    #mvu button{background:var(--btn);color:var(--btnfg);border:1px solid var(--bd);border-radius:4px;padding:5px 9px;cursor:pointer;margin:0 4px 6px 0}
    #mvu button:hover{background:var(--btnh)}
    #mvu button.p{background:#2e5aa8;border-color:#3b6fcc;color:#fff}
    #mvu input[type=text]{width:100%;box-sizing:border-box;background:var(--inp);color:var(--fg);border:1px solid var(--bd);border-radius:4px;padding:4px;margin:2px 0 6px}
    #mvu .sec{font-weight:bold;margin:8px 0 3px;border-bottom:1px solid var(--bd)}
    #mvu .mu{padding:2px 0;border-bottom:1px dotted var(--dot)}
    #mvu .w{color:var(--win);font-weight:bold} #mvu .l{color:var(--lose)} #mvu .t{color:var(--tie);font-weight:bold}
    #mvu .st{color:var(--st);margin:4px 0;font-size:12px} #mvu .er{color:var(--err)}
  `;
  document.head.append(css);

  const say = (msg, err) => { status.textContent = msg; status.className = 'st' + (err ? ' er' : ''); };
  const status = h('div', { className: 'st' });
  const results = h('div');
  const fromIn = h('input', { type: 'text', placeholder: 'first reply # (blank = from start)' });
  const toIn = h('input', { type: 'text', placeholder: 'last reply # (blank = to end)' });
  const settings = h('div', { style: 'display:none;margin-bottom:6px' },
    h('div', {}, 'Round range (the #N badges on posts show reply numbers; the OP is #1)'), fromIn, toIn);
  const body = h('div', { className: 'bd' },
    h('button', { className: 'p', onclick: onCollect }, 'Collect Votes'),
    h('button', { onclick: () => { settings.style.display = settings.style.display === 'none' ? 'block' : 'none'; } }, '⚙ Range'),
    h('button', { onclick: onClear }, 'Clear'),
    settings, status, results);
  const panel = h('div', { id: 'mvu' },
    h('div', { className: 'hd', onclick: () => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; } },
      h('span', {}, 'Vote Results'), h('span', {}, '▾')),
    body);
  document.body.append(panel);

  // Small "#N" badge on each post so you know which number to enter. OP = #1.
  function addBadges() {
    const sp = parseInt(new URLSearchParams(location.search).get('show'), 10);
    const offset = Number.isFinite(sp) && sp > 0 ? sp : 0;
    const msgs = getMessages(document);
    msgs.forEach((m, i) => {
      m.num = offset + i + 1;
      let b = m.el.querySelector(':scope > .mvc-badge');
      if (!b) {
        b = h('span', { className: 'mvc-badge', style: 'display:inline-block;background:#2e5aa8;color:#fff;font:bold 11px Arial;padding:1px 6px;border-radius:8px;margin:0 0 4px' });
        m.el.prepend(b);
      }
      b.textContent = '#' + m.num;
    });
    return msgs;
  }

  function render(res) {
    results.textContent = '';
    for (const s of res.sections) {
      if (res.sections.length > 1 || s.name !== 'Matchups') results.append(h('div', { className: 'sec' }, s.name));
      for (const m of s.matchups) {
        const c1 = m.winner === m.p1 ? 'w' : m.winner ? 'l' : 't';
        const c2 = m.winner === m.p2 ? 'w' : m.winner ? 'l' : 't';
        results.append(h('div', { className: 'mu' },
          `${m.num}. `, h('span', { className: c1 }, `${m.p1} (${m.v1})`), ' v ',
          h('span', { className: c2 }, `${m.p2} (${m.v2})`),
          m.winner ? '' : h('span', { className: 't' }, '  TIE')));
      }
    }
  }

  const rangeText = r => `Counting replies #${r.from ?? 'start'} to #${r.to ?? 'end'}.`;
  function refresh() {
    const st = loadState();
    if (!st.matchups) return null;
    const res = countAll(st);
    render(res);
    return res;
  }

  const parseNum = v => { const n = parseInt(String(v).replace(/\D/g, ''), 10); return n > 0 ? n : null; };
  function onRangeChange() {
    const st = loadState();
    st.range = { from: parseNum(fromIn.value), to: parseNum(toIn.value) };
    if (st.range.from && st.range.to && st.range.from > st.range.to) { say('First reply # is bigger than last reply #.', true); return; }
    saveState(st);
    const r = refresh();
    if (r) say(rangeText(r));
  }
  fromIn.addEventListener('change', onRangeChange);
  toIn.addEventListener('change', onRangeChange);

  async function onCollect() {
    try {
      say('Reading page…');
      const st = loadState();
      const msgs = addBadges();
      if (!msgs.length) { say('No posts found on this page.', true); return; }

      let matchupPostId = null, mu = null;
      for (const m of msgs) {
        if (/give your vote/i.test(extractLines(m.el, false).join('\n'))) {
          const parsed = parseMatchups(m.el);
          if (parsed) { mu = parsed; matchupPostId = m.id; break; }
        }
      }
      if (!mu && st.matchups) mu = st.matchups;
      if (!mu) { say('Fetching matchups from page 1…'); mu = await fetchPageOneMatchups(); }
      if (!mu) { say('Could not find the "Give your vote" matchups in the #1 post.', true); return; }

      let note = '';
      if (st.matchups && JSON.stringify(st.matchups) !== JSON.stringify(mu)) {
        st.posts = {}; st.range = { from: null, to: null }; fromIn.value = ''; toIn.value = '';
        note = ' New round detected - old votes cleared.';
      }
      st.matchups = mu;

      for (const m of msgs) {
        if (m.id === matchupPostId) continue;
        st.posts[m.id] = { user: findUser(m.el), lines: extractLines(m.el, false), num: m.num };
      }
      saveState(st);
      const res = refresh();
      say(rangeText(res) + note + ' Collect on each page of the round to add more votes.');
    } catch (e) {
      console.error(e); say('Error: ' + e.message, true);
    }
  }

  function onClear() {
    if (!confirm('Clear all collected votes for this thread?')) return;
    GM_deleteValue(KEY); results.textContent = ''; say('Cleared.');
  }

  /* Theme: follow MAL's own look (page background), fall back to the system setting. */
  function pageIsDark() {
    const lum = c => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(',').map(parseFloat);
      if (a === 0) return null;
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    };
    for (const el of [document.body, document.documentElement]) {
      const l = el ? lum(getComputedStyle(el).backgroundColor) : null;
      if (l !== null) return l < 0.5;
    }
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyTheme() { panel.classList.toggle('light', !pageIsDark()); }
  applyTheme();
  const obs = new MutationObserver(applyTheme);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  addBadges();
  const st0 = loadState();
  if (st0.range.from) fromIn.value = st0.range.from;
  if (st0.range.to) toIn.value = st0.range.to;
  const r0 = refresh();
  say(r0 ? 'Showing previously collected votes. ' + rangeText(r0) : 'Open a voting-thread page and click Collect Votes.');
})();
