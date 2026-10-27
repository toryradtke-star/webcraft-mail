/*
 * webcraft-mail onsite script.
 *   <script src="https://mail.webcraftmn.com/wm.js" data-site="your-site" async></script>
 *
 * - Gives each browser an anonymous id (first-party cookie wm_id) and records
 *   page views, including client-side navigations in Next.js and other SPAs.
 * - Shows the site's popup and embedded forms by their trigger rules: signup
 *   forms join a list, lead (contact) forms go to the CRM.
 * - Arriving from an email link (?_wm=…) ties this browser to that person.
 * - Global Privacy Control turns off page-view tracking; forms still work,
 *   because signing up is an explicit opt-in.
 * API: wm.track(name, props), wm.open(formId). Calls made before the script
 * loads can be queued as window.wmq = [['track', 'Joined', {}]].
 */
(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[data-site][src*="wm.js"]');
  if (!script || window.wm && window.wm.loaded) return;
  var SITE = script.getAttribute('data-site');
  var API = new URL(script.src).origin;
  var GPC = navigator.globalPrivacyControl === true;
  var YEAR = 365 * 86400;

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem('wm:' + k); if (v === null) localStorage.removeItem('wm:' + k); else localStorage.setItem('wm:' + k, v); } catch (e) { return null; }
  }
  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function anonId() {
    var id = cookie('wm_id');
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      var a = new Uint8Array(12);
      crypto.getRandomValues(a);
      id = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    document.cookie = 'wm_id=' + id + '; Max-Age=' + YEAR + '; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    return id;
  }
  var ANON = anonId();

  function post(path, body) {
    body.site = SITE;
    body.anon_id = ANON;
    // text/plain keeps this a simple CORS request (no preflight); the server reads JSON either way.
    return fetch(API + path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body), keepalive: true, credentials: 'omit' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); });
  }
  function track(name, props, always) {
    if (GPC && !always) return Promise.resolve();
    return post('/api/track', { event: name, props: props || {}, url: location.href }).catch(function () {});
  }

  // Arrived from an email: tie this browser to the person, then tidy the URL.
  (function () {
    var u = new URL(location.href);
    var t = u.searchParams.get('_wm');
    if (!t) return;
    u.searchParams.delete('_wm');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    // They got the email, so they're on a list: no signup popup for them.
    post('/api/identify', { token: t }).then(function (r) { if (r.ok) { store('known', '1'); store('sub', '1'); clearTimers(); } }).catch(function () {});
  })();

  // ---- page views, including SPA navigations ----
  var lastPath = null;
  function pageView() {
    if (location.pathname + location.search === lastPath) return;
    lastPath = location.pathname + location.search;
    track('Viewed Page', { path: location.pathname, title: document.title, referrer: document.referrer || undefined });
    onRoute();
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); setTimeout(pageView, 0); return r; };
  });
  addEventListener('popstate', pageView);

  // ---- forms ----
  var config = null, popupShown = false, timers = [];
  var isMobile = function () { return matchMedia('(max-width: 767px)').matches; };

  function glob(pattern, path) {
    if (pattern === '*') return true;
    if (pattern.indexOf('*') < 0) return path === pattern || path.indexOf(pattern.replace(/\/$/, '') + '/') === 0;
    var re = new RegExp('^' + pattern.split('*').map(function (s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }).join('.*') + '$');
    return re.test(path);
  }
  function allowed(f) {
    var t = f.triggers || {}, path = location.pathname;
    if (t.hideIfSubscribed !== false && store('sub')) return false;
    if (t.urlInclude && t.urlInclude.length && !t.urlInclude.some(function (p) { return glob(p, path); })) return false;
    if (t.urlExclude && t.urlExclude.some(function (p) { return glob(p, path); })) return false;
    if (t.device === 'mobile' && !isMobile()) return false;
    if (t.device === 'desktop' && isMobile()) return false;
    var closed = Number(store('closed:' + f.id) || 0);
    if (closed && Date.now() - closed < (t.cooldownDays == null ? 7 : t.cooldownDays) * 864e5) return false;
    return true;
  }

  var CSS = ':host{all:initial}*{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}' +
    '.ov{position:fixed;inset:0;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:2147483646;animation:f .2s ease-out}' +
    '.box{background:#fff;color:#111827;border-radius:12px;max-width:420px;width:100%;padding:28px 24px 20px;position:relative;box-shadow:0 20px 50px rgba(0,0,0,.25)}' +
    '.emb{background:transparent;color:inherit;padding:0;max-width:480px}' +
    'h2{font-size:22px;line-height:1.25;margin:0 0 8px}p{font-size:15px;line-height:1.5;margin:0 0 14px}' +
    'input,select,textarea{display:block;width:100%;font-family:inherit;font-size:16px;padding:11px 12px;margin:0 0 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#111827}' +
    'button.go{width:100%;font-size:16px;font-weight:600;padding:12px;border:0;border-radius:8px;color:#fff;cursor:pointer}button.go[disabled]{opacity:.6}' +
    '.x{position:absolute;top:8px;right:8px;width:36px;height:36px;border:0;background:none;font-size:24px;line-height:1;color:#6b7280;cursor:pointer}' +
    'label.ck{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#4b5563;margin:0 0 10px}label.ck input{width:auto;margin:3px 0 0;flex:none}' +
    '.fine{font-size:12px;color:#6b7280;margin:10px 0 0}.fine a{color:inherit}.err{color:#b91c1c;font-size:14px;margin:0 0 10px}.hp{position:absolute;left:-9999px;height:0;overflow:hidden}' +
    '@keyframes f{from{opacity:0}to{opacity:1}}@media (prefers-reduced-motion:reduce){.ov{animation:none}}';

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }

  function build(f, popup, onClose) {
    var box = el('div', { class: popup ? 'box' : 'box emb' });
    if (popup) {
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', f.title);
      var x = el('button', { class: 'x', type: 'button', 'aria-label': 'Close' }, '×');
      x.onclick = onClose;
      box.appendChild(x);
    }
    box.appendChild(el('h2', {}, f.title));
    if (f.body) box.appendChild(el('p', {}, f.body));
    var form = el('form', { novalidate: '' });
    var err = el('p', { class: 'err', role: 'alert', hidden: '' });
    form.appendChild(err);
    var inputs = {};
    var LABELS = { email: 'Email address', first_name: 'First name', last_name: 'Last name', phone: 'Phone', message: 'Message' };
    f.fields.forEach(function (field) {
      // A field is a name, or {name, label, type, options} for a CRM custom field.
      var name = typeof field === 'string' ? field : field.name;
      var label = typeof field === 'string' ? LABELS[name] : field.label;
      var type = typeof field === 'string' ? null : field.type;
      var req = f.required.indexOf(name) >= 0;
      var attrs = { name: name, placeholder: label + (req && f.kind === 'lead' ? ' *' : ''), 'aria-label': label };
      if (req) attrs.required = '';
      var i;
      if (name === 'message' || type === 'textarea') { attrs.rows = '3'; i = el('textarea', attrs); }
      else if (type === 'select') {
        i = el('select', { name: name, 'aria-label': label });
        i.appendChild(el('option', { value: '' }, label + (req ? ' *' : '')));
        (field.options || []).forEach(function (o) { i.appendChild(el('option', { value: o }, o)); });
      } else {
        attrs.type = name === 'email' ? 'email' : name === 'phone' ? 'tel' : type === 'number' ? 'number' : type === 'date' ? 'date' : 'text';
        attrs.autocomplete = { email: 'email', first_name: 'given-name', last_name: 'family-name', phone: 'tel' }[name] || 'off';
        i = el('input', attrs);
      }
      inputs[name] = i;
      form.appendChild(i);
    });
    function tick(name, wording) {
      var lab = el('label', { class: 'ck' });
      var box = el('input', { type: 'checkbox', name: name });
      lab.appendChild(box);
      lab.appendChild(el('span', {}, wording));
      form.appendChild(lab);
      return box;
    }
    var smsBox = f.kind === 'lead' && f.smsConsent && inputs.phone ? tick('sms_consent', f.smsConsent) : null;
    var mktBox = f.kind === 'lead' && f.marketingOptIn ? tick('marketing', f.marketingOptIn) : null;
    var hp = el('div', { class: 'hp', 'aria-hidden': 'true' });
    hp.appendChild(el('input', { type: 'text', name: 'company', tabindex: '-1', autocomplete: 'off' }));
    form.appendChild(hp);
    var go = el('button', { class: 'go', type: 'submit' }, f.button);
    go.style.background = config.color;
    form.appendChild(go);
    var fine = el('p', { class: 'fine' }, f.consent + ' ');
    if (config.privacyUrl) { var a = el('a', { href: config.privacyUrl, target: '_blank', rel: 'noopener' }, 'Privacy policy'); fine.appendChild(a); }
    form.appendChild(fine);
    form.onsubmit = function (ev) {
      ev.preventDefault();
      var fail = function (msg, at) { err.textContent = msg; err.hidden = false; if (at) at.focus(); };
      var body = { form: f.id, company: form.elements.company.value, url: location.href };
      for (var n in inputs) body[n] = inputs[n].value.trim();
      if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return fail('Please enter a valid email address.', inputs.email);
      if (f.kind !== 'lead' && !body.email) return fail('Please enter a valid email address.', inputs.email);
      if (f.kind === 'lead' && !body.email && !body.phone) return fail('Please enter your email or phone number.', inputs.email || inputs.phone);
      for (var r = 0; r < f.required.length; r++) if (inputs[f.required[r]] && !body[f.required[r]]) return fail('Please fill in every field marked *.', inputs[f.required[r]]);
      if (smsBox) body.sms_consent = smsBox.checked;
      if (mktBox) body.marketing = mktBox.checked;
      if (f.kind === 'lead') body.referrer = document.referrer;
      go.disabled = true;
      err.hidden = true;
      post(f.kind === 'lead' ? '/api/lead' : '/api/subscribe', body)
        .then(function () {
          if (f.kind !== 'lead' || body.marketing) store('sub', '1');
          form.replaceWith(el('p', { role: 'status' }, f.success));
        })
        .catch(function (e) { fail(e.message); go.disabled = false; });
    };
    box.appendChild(form);
    return { box: box, first: inputs.first_name || inputs.email || inputs.phone };
  }

  function mount(container) {
    var root = container.attachShadow ? container.attachShadow({ mode: 'open' }) : container;
    var style = el('style', {});
    style.textContent = CSS;
    root.appendChild(style);
    return root;
  }

  function showPopup(f, force) {
    if (popupShown || (!force && !allowed(f))) return;
    popupShown = true;
    clearTimers();
    var host = el('div', { 'data-wm-form': f.id });
    document.body.appendChild(host);
    var root = mount(host);
    var before = document.activeElement;
    var ov = el('div', { class: 'ov' });
    function close() {
      store('closed:' + f.id, String(Date.now()));
      host.remove();
      removeEventListener('keydown', onKey, true);
      if (before && before.focus) before.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    var b = build(f, true, close);
    ov.appendChild(b.box);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    root.appendChild(ov);
    addEventListener('keydown', onKey, true);
    setTimeout(function () { b.first.focus(); }, 50);
    try { sessionStorage.setItem('wm:shown', '1'); } catch (e) {}
    track('Viewed Form', { form: f.id });
  }

  function clearTimers() {
    timers.forEach(function (t) { t(); });
    timers = [];
  }

  // Popup timing: the delay and the scroll depth must both be reached (when set);
  // exit intent shows it on its own. With neither set it waits 5 seconds.
  function armPopup(f) {
    var t = f.triggers || {};
    var hasTiming = t.delaySec != null || t.scrollPct != null;
    var delayOk = t.delaySec == null, scrollOk = t.scrollPct == null;
    var check = function () { if (delayOk && scrollOk) showPopup(f); };
    if (!hasTiming && !t.exitIntent) { delayOk = false; t = Object.assign({}, t, { delaySec: 5 }); hasTiming = true; }
    if (hasTiming) {
      if (t.delaySec != null) {
        var id = setTimeout(function () { delayOk = true; check(); }, t.delaySec * 1000);
        timers.push(function () { clearTimeout(id); });
      }
      if (t.scrollPct != null) {
        var onScroll = function () {
          var h = document.documentElement.scrollHeight - innerHeight;
          if (h <= 0 || (scrollY / h) * 100 >= t.scrollPct) { scrollOk = true; removeEventListener('scroll', onScroll); check(); }
        };
        addEventListener('scroll', onScroll, { passive: true });
        timers.push(function () { removeEventListener('scroll', onScroll); });
        onScroll();
      }
    }
    if (t.exitIntent && !isMobile()) {
      var onOut = function (e) { if (!e.relatedTarget && e.clientY <= 0) showPopup(f); };
      document.addEventListener('mouseout', onOut);
      timers.push(function () { document.removeEventListener('mouseout', onOut); });
    }
  }

  function renderEmbeds() {
    config.forms.forEach(function (f) {
      if (f.type !== 'embed' || !f.target) return;
      var t = f.triggers || {};
      var host = document.querySelector(f.target);
      if (!host || host.getAttribute('data-wm-form')) return;
      // Embeds ignore cooldown and timing; they hide only on page rules and after signup.
      if (!allowed(Object.assign({}, f, { triggers: Object.assign({}, t, { cooldownDays: 0 }) }))) return;
      host.setAttribute('data-wm-form', f.id);
      mount(host).appendChild(build(f, false).box);
    });
  }

  function onRoute() {
    if (!config) return;
    renderEmbeds();
    clearTimers();
    var shownThisSession = false;
    try { shownThisSession = !!sessionStorage.getItem('wm:shown'); } catch (e) {}
    if (popupShown || shownThisSession) return;
    var popups = config.forms.filter(function (f) { return f.type === 'popup' && allowed(f); });
    if (popups[0]) armPopup(popups[0]);
  }

  fetch(API + '/api/forms?site=' + encodeURIComponent(SITE), { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (c) { if (c) { config = c; onRoute(); } })
    .catch(function () {});

  var api = {
    loaded: true,
    track: function (name, props) { return track(name, props); },
    open: function (id) { var f = config && config.forms.filter(function (x) { return x.id === id; })[0]; if (f) { popupShown = false; showPopup(f, true); } },
  };
  var queued = window.wmq || [];
  window.wm = api;
  queued.forEach(function (c) { if (api[c[0]]) api[c[0]].apply(null, c.slice(1)); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pageView); else pageView();
})();
