// The bug button: a small round button in a corner of every app. Pressing it takes a picture of the
// page as it is, asks for a short note, and saves both to the admin site's Bug reports
// (admin.pacificfish.ca/#bugs), for Claude to look at later.
//
// ONE FILE, SEVERAL COPIES. This copy (admin-work/html/bugreport.js) is the original; the same bytes
// are in chess (site/js/bugreport.js), Syed Settlers (site/js/bugreport.js) and Honed
// (src/dev/bugreport.js). Change it here and copy it over the others.
//
// Use: BugReport.init({ app: 'chess', endpoint: 'https://bugs.pacificfish.ca/api/bugs' }), or a
// <script src=".../bugreport.js" data-app="chess" data-endpoint="..."> tag (it starts itself).
//   always: true   shows the button for everyone (the admin site, which only you can open).
//   Otherwise it's off until this browser opens any page of the app with ?bugs=on (?bugs=off hides it
//   again), so visitors to the public sites never see it.
//   app may be a function (the admin site names the tool that's open).
//   context: () => ({...})   extra facts about the app's state to save with the report (optional);
//   window.bugReportContext works the same way.
//   storage: ['key', ...]   localStorage entries to save with it too (chess's saved game, say);
//   data-storage="key1 key2" on the script tag.
//
// The picture: the page is copied (its elements, its stylesheets, pictures and canvases turned into
// data: URLs) into an SVG <foreignObject> and drawn onto a canvas. Nothing leaves the browser for it and
// no outside library is used, so it works under the sites' strict Content-Security-Policy (needs only
// img-src data:). Not everything comes out: other sites' fonts and pictures, video, iframes, and a
// scroll position inside a scrolled box may be off. When a picture can't be taken, or to show
// something else, "Use a picture instead" attaches a screenshot made the normal way.
//
// Sending: from another pacificfish.ca site it's a plain cross-origin POST (Content-Type text/plain,
// so no preflight) with credentials to bugs.pacificfish.ca: the admin server, behind its own Access
// application that lets in the admins and the reporters (Matt), and that can only take new reports.
// It's the same *site*, so the browser sends that hostname's Access cookie, and the server checks the
// Origin against its list. If this browser isn't signed in there, the report is kept on this device
// (IndexedDB) and the box offers "Sign in to send" (bugs.pacificfish.ca/signin, which comes back here;
// the kept report is sent when the page loads again), and it can be downloaded as a file.
(function () {
  'use strict';
  if (window.BugReport) return;

  const FLAG = 'bugButton';          // localStorage 'on': show the button on a site where it's off by default
  const POS = 'bugButtonPos';        // where it was dragged to, as fractions of the screen
  const MAX_PIXELS = 4e6;            // the picture's size cap (a 2000 x 2000 equivalent)
  const MAX_FILE = 1.5e6;            // a stylesheet's picture or font bigger than this is left out
  const errors = [];                 // the page's last errors, saved with a report
  let opts = null, button = null, badge = null, busy = false;

  // --- The page's errors, from as early as this file loads ------------------------------------------
  function remember(kind, text) {
    errors.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 800) });
    if (errors.length > 25) errors.shift();
  }
  // Safari's stack has no message line, Chrome's starts with one
  const describe = x => x instanceof Error ? (x.stack && x.stack.includes(x.message) ? x.stack : `${x.name}: ${x.message}${x.stack ? '\n' + x.stack : ''}`)
    : x && typeof x === 'object' ? safeJson(x, 400) : String(x);
  addEventListener('error', e => {
    if (e.message) remember('error', e.message + (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno}:${e.colno})` : ''));
  });
  addEventListener('unhandledrejection', e => remember('rejection', e.reason === undefined ? 'undefined' : describe(e.reason)));
  const consoleError = console.error;
  console.error = function (...args) {
    try { remember('console', args.map(describe).join(' ')); } catch { /* never break logging */ }
    return consoleError.apply(this, args);
  };

  function safeJson(x, limit) {
    try { const s = JSON.stringify(x); return s && s.length > limit ? s.slice(0, limit) + '…' : s; } catch { return String(x); }
  }
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // --- Small helpers -----------------------------------------------------------------------------------
  function el(tag, css, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    if (css) e.style.cssText = css;    // CSSOM, which a strict style-src allows (a style="" attribute it wouldn't)
    e.setAttribute('data-bugreport', '');
    e.append(...kids);
    return e;
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  function icon(size) {
    const s = document.createElementNS(svgNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('aria-hidden', 'true');
    // a beetle: body, head, legs
    for (const d of ['M12 7.5c-3 0-5 2.4-5 5.6 0 3.4 2.2 5.9 5 5.9s5-2.5 5-5.9c0-3.2-2-5.6-5-5.6z',
      'M9.2 7.6a2.8 2.8 0 0 1 5.6 0', 'M12 9v10', 'M7 12H4M7 15.5l-2.6 1.4M7.4 9.6 5 8.2M17 12h3M17 15.5l2.6 1.4M16.6 9.6 19 8.2',
      'M10.2 5.2 9 3.6M13.8 5.2 15 3.6']) {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.7');
      p.setAttribute('stroke-linecap', 'round');
      s.append(p);
    }
    return s;
  }
  const readAsDataUrl = blob => new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => bad(r.error);
    r.readAsDataURL(blob);
  });
  const loadImage = src => new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => bad(new Error('the picture could not be drawn'));
    img.src = src;
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // --- The picture of the page -------------------------------------------------------------------------
  const fetched = new Map();   // url -> data: URL (or null), within one picture
  function inline(url) {
    if (!fetched.has(url)) {
      fetched.set(url, (async () => {
        try {
          const r = await fetch(url, { credentials: 'same-origin' });
          if (!r.ok) return null;
          const blob = await r.blob();
          return blob.size > MAX_FILE ? null : await readAsDataUrl(blob);
        } catch { return null; }   // another site's file, or a blocked one: left out
      })());
    }
    return fetched.get(url);
  }

  // url(...) in CSS text, turned into data: URLs so the copy can show them
  async function inlineUrls(text, base) {
    const found = [...text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
    if (!found.length) return text;
    const map = new Map();
    await Promise.all(found.map(async m => {
      const raw = m[2].trim();
      if (/^(data:|#)/.test(raw) || map.has(raw)) return;
      let abs;
      try { abs = new URL(raw, base).href; } catch { return; }
      map.set(raw, null);
      map.set(raw, await inline(abs));
    }));
    return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q, raw) => {
      const d = map.get(raw.trim());
      return d ? `url("${d}")` : /^(data:|#)/.test(raw.trim()) ? all : 'none';
    });
  }

  async function pageCss() {
    const parts = [];
    const walk = async (sheet) => {
      let rules;
      try { rules = sheet.cssRules; } catch { return; }   // another site's stylesheet: can't be read
      const base = sheet.href || location.href;
      for (const r of rules) {
        if (r.styleSheet) { await walk(r.styleSheet); continue; }   // @import
        parts.push(await inlineUrls(r.cssText, base));
      }
    };
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) await walk(sheet);
    // In the copy, the root element is the SVG, not <html>
    return parts.join('\n').replace(/:root\b/g, 'html');
  }

  // The size an element takes, written into the copy when it changes tag (a canvas becomes an <img>)
  function keepBox(from, to) {
    const cs = getComputedStyle(from);
    for (const p of ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'margin', 'transform',
      'transform-origin', 'z-index', 'opacity', 'border-radius', 'pointer-events', 'object-fit', 'vertical-align']) {
      to.style.setProperty(p, cs.getPropertyValue(p));
    }
  }

  async function copyOf(node, jobs) {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) return document.createTextNode(node.data);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.hasAttribute('data-bugreport')) return null;
    const tag = node.localName;
    if (['script', 'noscript', 'template', 'link', 'style', 'iframe', 'object', 'embed', 'meta', 'base', 'title'].includes(tag)
      && node.namespaceURI !== svgNS) {
      if (tag !== 'iframe') return null;
      const box = document.createElement('div');
      keepBox(node, box);
      box.style.background = '#8884';
      return box;
    }
    if (tag === 'style' && node.namespaceURI === svgNS) return null;   // in document.styleSheets already
    if (tag === 'canvas') {
      const img = document.createElement('img');
      for (const a of node.attributes) if (a.name !== 'width' && a.name !== 'height') img.setAttribute(a.name, a.value);
      keepBox(node, img);
      try { img.src = node.toDataURL(); } catch { img.alt = '(canvas)'; }
      return img;
    }
    if (tag === 'video') {
      const img = document.createElement('img');
      keepBox(node, img);
      try {
        const c = document.createElement('canvas');
        c.width = node.videoWidth || 1;
        c.height = node.videoHeight || 1;
        c.getContext('2d').drawImage(node, 0, 0, c.width, c.height);
        img.src = c.toDataURL();
      } catch { /* blank */ }
      return img;
    }
    const copy = node.cloneNode(false);
    copy.removeAttribute('srcset');
    if (tag === 'img' && node.currentSrc && !node.currentSrc.startsWith('data:')) {
      jobs.push((async () => {
        let d = await inline(node.currentSrc);
        if (!d && node.complete && node.naturalWidth) {   // a blob: picture, say: draw it instead
          try {
            const c = document.createElement('canvas');
            c.width = node.naturalWidth;
            c.height = node.naturalHeight;
            c.getContext('2d').drawImage(node, 0, 0);
            d = c.toDataURL();
          } catch { /* left out */ }
        }
        if (d) copy.setAttribute('src', d); else copy.removeAttribute('src');
      })());
    }
    if (tag === 'image' && node.namespaceURI === svgNS) {
      const href = node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (href && !href.startsWith('data:')) {
        jobs.push(inline(new URL(href, location.href).href).then(d => {
          if (d) { copy.setAttribute('href', d); copy.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); }
        }));
      }
    }
    if (tag === 'input') {
      if (node.type === 'checkbox' || node.type === 'radio') {
        if (node.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked');
      } else if (node.type !== 'password' && node.type !== 'file') {
        copy.setAttribute('value', node.value);
      } else if (node.type === 'password') {
        copy.setAttribute('value', node.value ? '••••••' : '');
      }
    }
    if (tag === 'option') {
      if (node.selected) copy.setAttribute('selected', ''); else copy.removeAttribute('selected');
    }
    if (tag === 'details' && node.open) copy.setAttribute('open', '');
    if (tag === 'dialog' && node.open) {
      // a modal box sits in the browser's top layer, which the copy doesn't have: put it on top by hand
      copy.setAttribute('open', '');
      const r = node.getBoundingClientRect();
      copy.style.setProperty('position', 'fixed');
      copy.style.setProperty('inset', 'auto');
      copy.style.setProperty('left', r.left + 'px');
      copy.style.setProperty('top', r.top + 'px');
      copy.style.setProperty('width', r.width + 'px');
      copy.style.setProperty('height', r.height + 'px');
      copy.style.setProperty('margin', '0');
      copy.style.setProperty('z-index', '2147483000');
      copy.style.setProperty('box-sizing', 'border-box');
    }
    if (tag === 'textarea') {
      copy.textContent = node.value;
    } else {
      for (const kid of node.childNodes) {
        const k = await copyOf(kid, jobs);
        if (k) copy.append(k);
      }
      for (const kid of node.shadowRoot ? node.shadowRoot.childNodes : []) {   // an open shadow root, flattened
        const k = await copyOf(kid, jobs);
        if (k) copy.append(k);
      }
    }
    // A box scrolled inside: its contents moved up/left as far as it's scrolled
    if ((node.scrollTop || node.scrollLeft) && node !== document.documentElement && node !== document.body) {
      copy.style.setProperty('overflow', 'hidden');
      for (const k of copy.children) {
        k.style.setProperty('translate', `${-node.scrollLeft}px ${-node.scrollTop}px`);
      }
    }
    return copy;
  }

  async function takePicture() {
    fetched.clear();
    const W = document.documentElement.clientWidth || innerWidth;
    const H = innerHeight;
    const jobs = [];
    const [css, html] = await Promise.all([pageCss(), copyOf(document.documentElement, jobs)]);
    await Promise.all(jobs);
    const head = html.querySelector('head') || html.insertBefore(document.createElement('head'), html.firstChild);
    const style = document.createElement('style');
    style.textContent = css;
    head.append(style);
    // The copy shows the screen as it is: the viewport's size, scrolled where the page is scrolled
    html.style.setProperty('width', W + 'px');
    html.style.setProperty('height', H + 'px');
    html.style.setProperty('overflow', 'hidden');
    const body = html.querySelector('body');
    if (body && (scrollX || scrollY)) {
      if (getComputedStyle(document.body).position === 'static') body.style.setProperty('position', 'relative');
      body.style.setProperty('top', `${-scrollY}px`);
      body.style.setProperty('left', `${-scrollX}px`);
    }
    const xml = new XMLSerializer().serializeToString(html).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const svg = `<svg xmlns="${svgNS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<foreignObject x="0" y="0" width="${W}" height="${H}">${xml}</foreignObject></svg>`;
    const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (W * H)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    const ctx = canvas.getContext('2d');
    const bg = [document.body, document.documentElement].map(e => e && getComputedStyle(e).backgroundColor)
      .find(c => c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) || '#ffffff';
    const draw = () => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    draw();
    await wait(60);   // Safari sometimes draws a copy's pictures only the second time
    draw();
    return { image: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height };
  }

  // A picture chosen by hand (a screenshot from the phone, say), made smaller to send
  async function pictureFromFile(file) {
    const img = await loadImage(await readAsDataUrl(file));
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { image: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height };
  }

  // --- Reports kept on this device until they're sent ---------------------------------------------------
  function queueDb() {
    return new Promise((ok, bad) => {
      const req = indexedDB.open('bug-reports', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('queue', { autoIncrement: true });
      req.onsuccess = () => ok(req.result);
      req.onerror = () => bad(req.error);
    });
  }
  async function queueDo(mode, fn) {
    const db = await queueDb();
    try {
      return await new Promise((ok, bad) => {
        const tx = db.transaction('queue', mode);
        const out = fn(tx.objectStore('queue'));
        tx.oncomplete = () => ok(out && 'result' in out ? out.result : undefined);
        tx.onerror = () => bad(tx.error);
      });
    } finally { db.close(); }
  }
  const queueAdd = report => queueDo('readwrite', s => s.add(report));
  const queueAll = () => queueDo('readonly', s => {
    const out = { result: [] };
    s.openCursor().onsuccess = e => { const c = e.target.result; if (c) { out.result.push([c.key, c.value]); c.continue(); } };
    return out;
  });
  const queueDelete = key => queueDo('readwrite', s => s.delete(key));

  async function send(report) {
    const target = new URL(opts.endpoint, location.href);
    const same = target.origin === location.origin;
    let r;
    try {
      r = await fetch(target.href, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        // From another site: text/plain and no extra headers, so the browser sends it without asking
        // the server first (a preflight Cloudflare Access would refuse)
        headers: same ? { 'Content-Type': 'application/json', 'X-Requested-With': 'admin' } : { 'Content-Type': 'text/plain' },
        body: JSON.stringify(report),
      });
    } catch {
      throw new Error(same ? 'Couldn’t reach the admin site.' : 'Couldn’t send it: this browser may not be signed in for bug reports yet.');
    }
    let reply = {};
    try { reply = await r.json(); } catch { /* not JSON: a sign-in page */ }
    if (!r.ok) throw new Error(reply.error ? reply.error + '.' : `The bug report server answered ${r.status}.`);
    return reply;
  }

  async function sendQueued() {
    let items;
    try { items = await queueAll(); } catch { return 0; }
    let left = items.length;
    for (const [key, report] of items) {
      try {
        await send(report);
        await queueDelete(key);
        left--;
      } catch { break; }   // still not signed in: try again next time
    }
    showBadge(left);
    return left;
  }

  function showBadge(n) {
    if (!badge) return;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n ? 'block' : 'none';
    if (button) button.title = n ? `Report a bug (${n} waiting to be sent)` : 'Report a bug';
  }

  // --- The report box -----------------------------------------------------------------------------------
  const BTN = 'font:inherit;font-size:15px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid #4a5568;background:#2d3748;color:#f1f5f9;';
  const PRIMARY = 'font:inherit;font-size:15px;font-weight:600;padding:8px 16px;border-radius:8px;cursor:pointer;border:1px solid #3b82c4;background:#1d5f99;color:#fff;';

  function appName() {
    try { return String(typeof opts.app === 'function' ? opts.app() : opts.app).toLowerCase(); } catch { return 'app'; }
  }

  async function open() {
    if (busy) return;
    busy = true;
    button.style.opacity = '0';
    let shot = null, shotError = '';
    const started = performance.now();
    try {
      shot = await takePicture();
    } catch (e) {
      shotError = (e && e.message) || String(e);
    }
    const took = Math.round(performance.now() - started);
    button.style.opacity = '';
    const context = (() => {
      try {
        const fn = opts.context || window.bugReportContext;
        const saved = {};
        for (const k of opts.storage || []) { const v = storage.get(k); if (v !== null) saved[k] = v.slice(0, 20000); }
        const out = { ...(fn ? { app: fn() } : {}), ...(Object.keys(saved).length ? { storage: saved } : {}) };
        return Object.keys(out).length ? safeJson(out, 40000) : null;
      } catch (e) { return `context failed: ${e.message}`; }
    })();
    const facts = {
      app: appName(), url: location.href, title: document.title, at: new Date().toISOString(),
      tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })(),
      viewport: { w: innerWidth, h: innerHeight, dpr: window.devicePixelRatio || 1, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
      ua: navigator.userAgent, standalone: !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches),
      errors: errors.slice(), context, captureMs: took,
    };
    showBox(shot, shotError, facts);
  }

  function showBox(shot, shotError, facts) {
    let picture = shot, source = shot ? 'capture' : '';
    const dialog = el('dialog', 'box-sizing:border-box;width:min(30rem,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:16px;margin:auto;' +
      'border:1px solid #4a5568;border-radius:12px;background:#1a202c;color:#f1f5f9;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'box-shadow:0 20px 50px rgba(0,0,0,.6);text-align:left;', { className: 'bugreport-box' });
    dialog.setAttribute('aria-label', 'Report a bug');
    const title = el('h2', 'margin:0 0 10px;font-size:18px;font-weight:700;color:#f1f5f9;', { textContent: 'Report a bug' });
    const preview = el('img', 'display:block;max-width:100%;max-height:38vh;margin:0 auto;border:1px solid #4a5568;border-radius:6px;background:#fff;cursor:zoom-in;', { alt: 'Screenshot of the page' });
    const previewNote = el('p', 'margin:6px 0 0;font-size:13px;color:#a0aec0;');
    const include = el('input', '', { type: 'checkbox', checked: true });
    const includeLabel = el('label', 'display:flex;align-items:center;gap:6px;font-size:14px;color:#cbd5e0;cursor:pointer;', {}, include, 'Include the picture');
    const file = el('input', 'display:none;', { type: 'file', accept: 'image/*' });
    const pick = el('button', BTN + 'font-size:13px;padding:5px 10px;', { type: 'button', textContent: 'Use a picture instead…' });
    const shotRow = el('div', 'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 12px;', {}, includeLabel, pick, file);
    const note = el('textarea', 'box-sizing:border-box;display:block;width:100%;min-height:90px;resize:vertical;padding:8px 10px;border-radius:8px;' +
      'border:1px solid #4a5568;background:#0f141b;color:#f1f5f9;font:inherit;font-size:16px;', { placeholder: 'What went wrong? What did you expect?', rows: 4, maxLength: 4000 });
    note.setAttribute('aria-label', 'Note');
    const status = el('p', 'margin:8px 0 0;min-height:1.2em;font-size:14px;color:#a0aec0;', { role: 'status' });
    const cancel = el('button', BTN, { type: 'button', textContent: 'Cancel' });
    const save = el('button', PRIMARY, { type: 'button', textContent: 'Save' });
    const download = el('button', BTN + 'display:none;', { type: 'button', textContent: 'Download it' });
    const row = el('div', 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:12px;', {}, download, cancel, save);
    const viewAll = el('a', 'font-size:13px;color:#7cc4fa;', { href: 'https://admin.pacificfish.ca/#bugs', target: '_blank', rel: 'noopener', textContent: 'All bug reports' });
    dialog.append(title, preview, previewNote, shotRow, note, status, row, el('div', 'margin-top:10px;text-align:right;', {}, viewAll));

    function showPicture() {
      preview.style.display = picture ? 'block' : 'none';
      includeLabel.style.display = picture ? 'flex' : 'none';
      if (picture) preview.src = picture.image;
      previewNote.textContent = picture ? (source === 'file' ? 'Your picture.' : 'The page as it was, redrawn (not a screenshot). Tap it to see it bigger. If it doesn’t match your screen, use a real screenshot instead.')
        : `No picture of the page${shotError ? ` (${shotError})` : ''}. You can add one with “Use a picture instead”.`;
    }
    showPicture();
    preview.onclick = () => {
      const big = preview.style.maxHeight === 'none';
      preview.style.maxHeight = big ? '38vh' : 'none';
      preview.style.cursor = big ? 'zoom-in' : 'zoom-out';
    };
    pick.onclick = () => file.click();
    file.onchange = async () => {
      if (!file.files[0]) return;
      try {
        picture = await pictureFromFile(file.files[0]);
        source = 'file';
        include.checked = true;
        showPicture();
      } catch (e) { status.textContent = `Couldn’t open that picture: ${e.message}`; }
      file.value = '';
    };

    const report = () => ({
      ...facts, note: note.value.trim(),
      image: include.checked && picture ? picture.image : null,
      imageSource: include.checked && picture ? source : '', captureError: shotError,
    });
    const close = () => { dialog.close(); dialog.remove(); busy = false; };
    cancel.onclick = close;
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });   // Esc
    // Typing in the box mustn't reach the app's own keyboard shortcuts
    for (const type of ['keydown', 'keyup', 'keypress']) {
      dialog.addEventListener(type, e => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
      });
    }
    let kept = null;
    // Another site: sending needs this browser signed in at the bug server once. In this tab (a Home
    // Screen app has its own sign-ins, and a new tab would open in Safari instead); it comes back here.
    const signInLink = () => {
      const target = new URL(opts.endpoint, location.href);
      if (target.origin === location.origin) return;
      const href = `${target.origin}/signin?then=${encodeURIComponent(location.href)}`;
      status.append(' ', el('a', 'color:#7cc4fa;font-weight:600;', { href, className: 'bugreport-signin', textContent: 'Sign in to send' }));
    };
    save.onclick = async () => {
      save.disabled = cancel.disabled = true;
      status.style.color = '#a0aec0';
      status.textContent = 'Saving…';
      const r = report();
      try {
        await sendQueued();
        await send(r);
        status.style.color = '#68d391';
        status.textContent = 'Saved. Thanks!';
        await wait(800);
        close();
      } catch (e) {
        try {
          if (!kept) { await queueAdd(r); kept = r; }
          status.textContent = `${e.message} It’s kept on this device and will be sent next time.`;
        } catch {
          status.textContent = `${e.message} It couldn’t be kept on this device either: download it instead.`;
        }
        signInLink();
        status.style.color = '#f6ad55';
        download.style.display = '';
        cancel.textContent = 'Close';
        cancel.disabled = false;
        save.textContent = 'Try again';
        save.disabled = false;
        save.onclick = async () => {   // the copy is already kept: just try sending everything waiting
          save.disabled = true;
          status.style.color = '#a0aec0';
          status.textContent = 'Sending…';
          const left = await sendQueued();
          if (!left) { status.style.color = '#68d391'; status.textContent = 'Sent. Thanks!'; await wait(800); close(); return; }
          status.style.color = '#f6ad55';
          status.textContent = 'Still couldn’t send it. It stays on this device for next time.';
          signInLink();
          save.disabled = false;
        };
        showBadge(1);
        sendQueued().then(showBadge);
      }
    };
    download.onclick = () => {
      const a = el('a', 'display:none;', {
        href: 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(kept || report(), null, 1)),
        download: `bug-${facts.app}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      });
      document.body.append(a);
      a.click();
      a.remove();
    };

    // Above any box the app has open, which a later showModal() is
    document.body.append(dialog);
    dialog.showModal();
    note.focus();
  }

  // --- The button ---------------------------------------------------------------------------------------
  function placeButton() {
    // While the app shows a modal box, everything outside it can't be pressed: so the button goes in it
    const modals = [...document.querySelectorAll('dialog[open]')].filter(d => !d.hasAttribute('data-bugreport') && d.matches(':modal'));
    const home = modals.length ? modals[modals.length - 1] : document.body;
    if (button.parentNode !== home) home.append(button);
  }

  function moveTo(x, y) {   // x, y: the button's top-left corner in px
    const size = button.offsetWidth || 36;
    const left = Math.max(2, Math.min(innerWidth - size - 2, x));
    const top = Math.max(2, Math.min(innerHeight - size - 2, y));
    button.style.left = left + 'px';
    button.style.top = top + 'px';
    button.style.bottom = 'auto';
    return { left, top };
  }

  function makeButton() {
    button = el('button', 'position:fixed;left:8px;bottom:calc(8px + env(safe-area-inset-bottom, 0px));z-index:2147483000;width:36px;height:36px;' +
      'margin:0;padding:0;display:flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid rgba(255,255,255,.35);' +
      'background:rgba(30,39,51,.72);color:#e8ecf1;opacity:.6;cursor:pointer;touch-action:none;box-shadow:0 2px 8px rgba(0,0,0,.35);' +
      '-webkit-tap-highlight-color:transparent;transition:opacity .15s;', { type: 'button', title: 'Report a bug', className: 'bugreport-button' });
    button.setAttribute('aria-label', 'Report a bug');
    button.append(icon(20));
    badge = el('span', 'position:absolute;top:-4px;right:-4px;display:none;min-width:16px;height:16px;padding:0 3px;border-radius:8px;' +
      'background:#e53e3e;color:#fff;font:700 11px/16px system-ui,sans-serif;text-align:center;');
    button.append(badge);
    button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
    button.addEventListener('mouseleave', () => { button.style.opacity = '.6'; });
    // Drag it anywhere (it remembers where); a press without moving opens the report box
    let drag = null;
    button.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const r = button.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      try { button.setPointerCapture(e.pointerId); } catch { /* old browser */ }
    });
    button.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
      drag.moved = true;
      moveTo(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      if (moved) {
        const r = button.getBoundingClientRect();
        storage.set(POS, JSON.stringify({ x: r.left / innerWidth, y: r.top / innerHeight }));
        button.dataset.dragged = '1';   // the click that follows a drag isn't a press
        setTimeout(() => delete button.dataset.dragged, 50);
      }
    };
    button.addEventListener('pointerup', end);
    button.addEventListener('pointercancel', end);
    button.addEventListener('click', e => {
      e.stopPropagation();
      if (button.dataset.dragged) return;
      open();
    });
    for (const type of ['mousedown', 'touchstart', 'mouseup', 'touchend']) button.addEventListener(type, e => e.stopPropagation(), { passive: true });
    const restore = () => {
      try {
        const p = JSON.parse(storage.get(POS) || 'null');
        if (p && isFinite(p.x) && isFinite(p.y)) moveTo(p.x * innerWidth, p.y * innerHeight);
      } catch { /* start in the corner */ }
    };
    document.body.append(button);
    restore();
    addEventListener('resize', restore);
    placeButton();
    new MutationObserver(placeButton).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'], childList: true });
  }

  function init(options) {
    if (opts) return;
    opts = { app: 'app', endpoint: 'https://bugs.pacificfish.ca/api/bugs', always: false, ...options };
    // ?bugs=on or ?bugs=off: remembered by this browser, then taken out of the address
    try {
      const u = new URL(location.href);
      const asked = u.searchParams.get('bugs');
      if (asked === 'on' || asked === 'off') {
        storage.set(FLAG, asked === 'on' ? 'on' : null);
        u.searchParams.delete('bugs');
        history.replaceState(history.state, '', u.pathname + u.search + u.hash);
      }
    } catch { /* leave the address alone */ }
    if (!opts.always && storage.get(FLAG) !== 'on') return;
    const start = () => {
      makeButton();
      setTimeout(() => { sendQueued().catch(() => {}); }, 2500);   // anything kept from last time
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  window.BugReport = { init, takePicture, errors };
  const tag = document.currentScript;
  if (tag && tag.dataset.app) {
    init({ app: tag.dataset.app, endpoint: tag.dataset.endpoint || undefined, always: tag.dataset.always === 'true',
      storage: (tag.dataset.storage || '').split(/\s+/).filter(Boolean) });
  }
})();
