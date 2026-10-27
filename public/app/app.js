/*
 * webcraft CRM owner app: the inbox, contacts, pipeline, calendar and tasks
 * for a business owner, on a phone or a desk. Plain script, no build step.
 *
 * Talks to /app/api/* (src/owner.ts). The session is an HttpOnly cookie; every
 * write sends X-Requested-With: wm-app. All text from the API goes in with
 * textContent (the h() helper), never as HTML.
 *
 * Routes: #home #inbox #contacts #contact/<id> #pipeline #calendar #tasks
 */
(function () {
  'use strict';
  var root = document.getElementById('app');
  var S = { me: null, sites: [], site: null, setup: null, unread: 0, nav: null, main: null, seq: 0 };

  // ---------- small helpers ----------

  function h(tag, attrs) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') for (var ev in v) e.addEventListener(ev, v[ev]);
      else if (k === 'class') e.className = v;
      else if (k === 'value') e.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') e[k] = !!v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, kid) {
    if (kid === undefined || kid === null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { add(e, k); }); return; }
    e.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem('wm-app:' + k); localStorage.setItem('wm-app:' + k, v); } catch (e) { return null; }
  }

  async function api(path, body) {
    var url = '/app/api' + path;
    var opts = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/json';
      opts.headers['x-requested-with'] = 'wm-app';
      opts.body = JSON.stringify(Object.assign({ site: S.site }, body));
    } else if (S.site && path !== '/me') {
      url += (path.indexOf('?') >= 0 ? '&' : '?') + 'site=' + encodeURIComponent(S.site);
    }
    var r = await fetch(url, opts);
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 401 && path !== '/login') { signin(); throw new Error('Signed out.'); }
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    return j;
  }

  /** Runs an action from a button or form, showing its error next to it. */
  function act(errEl, fn) {
    return async function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      var btn = ev && ev.currentTarget && ev.currentTarget.tagName === 'BUTTON' ? ev.currentTarget : null;
      if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
      if (btn) btn.disabled = true;
      try { await fn(ev); } catch (e) {
        if (errEl) { errEl.textContent = e.message; errEl.hidden = false; }
      } finally { if (btn && btn.isConnected) btn.disabled = false; }
    };
  }
  function errBox() { return h('p', { class: 'err', role: 'alert', hidden: true }); }

  // ---------- time, in the business's own zone ----------

  function tz() { return (S.setup && S.setup.timezone) || undefined; }
  function fmt(d, o) { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz() }, o)).format(new Date(d)); }
  function when(d) { return fmt(d, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function timeOf(d) { return fmt(d, { hour: 'numeric', minute: '2-digit' }); }
  function dayOf(d) { return fmt(d, { weekday: 'long', month: 'short', day: 'numeric' }); }
  function localDate(d) {
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(d)).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }
  function addDays(date, n) {
    var a = date.split('-').map(Number);
    return new Date(Date.UTC(a[0], a[1] - 1, a[2] + n)).toISOString().slice(0, 10);
  }
  /** "2026-10-28T14:30" read as the business's wall clock, to an ISO instant. */
  function zoned(local) {
    if (!local) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
    if (!m) return '';
    var want = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]), t = want;
    for (var i = 0; i < 3; i++) {
      var p = {};
      new Intl.DateTimeFormat('en-US', { timeZone: tz(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
      var seen = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute);
      if (seen === want) break;
      t += want - seen;
    }
    return new Date(t).toISOString();
  }
  function ago(d) {
    var m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    if (m < 1440) return Math.round(m / 60) + 'h';
    if (m < 14 * 1440) return Math.round(m / 1440) + 'd';
    return fmt(d, { month: 'short', day: 'numeric' });
  }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  function stageName(pipelineId, stageId) {
    var p = (S.setup.pipelines || []).find(function (x) { return x.id === pipelineId; });
    var s = p && p.stages.find(function (x) { return x.id === stageId; });
    return s ? s.name : stageId;
  }
  function calName(id) {
    var c = (S.setup.calendars || []).find(function (x) { return x.id === id; });
    return c ? c.name : id;
  }

  // ---------- sign-in and the shell ----------

  function signin() {
    S.me = null;
    var err = errBox(), done = h('p', { class: 'ok', role: 'status', hidden: true });
    var email = h('input', { type: 'email', name: 'email', autocomplete: 'email', placeholder: 'you@business.com', 'aria-label': 'Email address', required: true });
    var form = h('form', { on: { submit: act(err, async function () {
      await api('/login', { email: email.value });
      form.hidden = true;
      done.textContent = 'Check your email for a sign-in link. It works for 15 minutes.';
      done.hidden = false;
    }) } }, email, h('button', { class: 'btn primary', type: 'submit' }, 'Email me a sign-in link'));
    clear(root).appendChild(h('div', { class: 'signin' }, h('h1', {}, 'Sign in'), h('p', { class: 'muted' }, 'Enter the email your business set up for you.'), form, err, done));
    email.focus();
  }

  var TABS = [['home', 'Home', '⌂'], ['inbox', 'Inbox', '✉'], ['contacts', 'Contacts', '☺'], ['pipeline', 'Pipeline', '▤'], ['calendar', 'Calendar', '▦'], ['tasks', 'Tasks', '✓']];

  function shell() {
    var side = h('nav', { class: 'side', 'aria-label': 'Main' }, h('div', { class: 'brand' }, S.setup.name));
    var tabs = h('nav', { class: 'tabs', 'aria-label': 'Main' });
    TABS.forEach(function (t) {
      side.appendChild(h('a', { href: '#' + t[0], 'data-tab': t[0] }, h('span', { 'aria-hidden': 'true' }, t[2]), t[1]));
      tabs.appendChild(h('a', { href: '#' + t[0], 'data-tab': t[0] }, h('span', { 'aria-hidden': 'true' }, t[2]), t[1]));
    });
    var foot = h('div', { class: 'side-foot' });
    if (S.sites.length > 1) foot.appendChild(siteSwitcher());
    foot.appendChild(h('div', {}, S.me.email));
    foot.appendChild(h('button', { class: 'btn small', type: 'button', on: { click: act(null, async function () { await api('/logout', {}); signin(); }) } }, 'Sign out'));
    side.appendChild(foot);
    S.main = h('main', { id: 'main' });
    S.nav = [side, tabs];
    clear(root).appendChild(h('div', { class: 'shell' }, side, S.main, tabs));
  }

  function siteSwitcher() {
    var sel = h('select', { 'aria-label': 'Business', on: { change: function () { pickSite(sel.value); } } },
      S.sites.map(function (s) { return h('option', { value: s.id, selected: s.id === S.site }, s.name); }));
    return sel;
  }

  async function pickSite(id) {
    S.site = id;
    store('site', id);
    var u = new URL(location.href);
    u.searchParams.set('site', id);
    history.replaceState(null, '', u.pathname + u.search + u.hash);
    S.setup = await api('/setup');
    document.title = S.setup.name + ' · CRM';
    shell();
    route();
  }

  function markNav(tab) {
    (S.nav || []).forEach(function (n) {
      [].forEach.call(n.querySelectorAll('a[data-tab]'), function (a) {
        if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        var old = a.querySelector('.badge');
        if (old) old.remove();
        if (a.getAttribute('data-tab') === 'inbox' && S.unread) a.appendChild(h('span', { class: 'badge', 'aria-label': S.unread + ' unread' }, S.unread));
      });
    });
  }

  async function refreshBadge(tab) {
    try { S.unread = (await api('/home')).unread; } catch (e) { /* the view shows its own errors */ }
    markNav(tab);
  }

  function page(title, actions) {
    clear(S.main);
    S.main.appendChild(h('div', { class: 'top' }, h('h1', {}, title), actions));
    return S.main;
  }

  async function route() {
    if (!S.setup) return;
    var hash = location.hash.replace(/^#/, '') || 'home';
    var parts = hash.split('/');
    var seq = ++S.seq;
    var tab = parts[0] === 'contact' ? 'contacts' : parts[0];
    markNav(tab);
    var views = { home: home, inbox: inbox, contacts: contacts, contact: contact, pipeline: pipeline, calendar: calendar, tasks: tasks };
    var view = views[parts[0]] || home;
    try {
      await view(parts[1], seq);
    } catch (e) {
      if (seq === S.seq && S.main) page('Something went wrong').appendChild(h('p', { class: 'err' }, e.message));
    }
    if (seq === S.seq) { refreshBadge(tab); window.scrollTo(0, 0); }
  }
  /** True once a newer navigation started, so a slow view doesn't draw over it. */
  function stale(seq) { return seq !== S.seq; }

  // ---------- Home ----------

  async function home(_, seq) {
    var d = await api('/home');
    if (stale(seq)) return;
    S.unread = d.unread;
    var m = page('Today');
    m.appendChild(h('div', { class: 'stats' },
      stat('#inbox', d.unread, d.unread === 1 ? 'unread conversation' : 'unread conversations'),
      stat('#tasks', d.tasksDue, 'tasks due today or late'),
      stat('#calendar', d.today.length, d.today.length === 1 ? 'appointment today' : 'appointments today'),
      stat('#contacts', d.newContacts7d, 'new contacts this week')));
    var list = h('ul', { class: 'list' });
    d.today.forEach(function (a) {
      list.appendChild(h('li', {}, h('a', { class: 'item', href: '#contact/' + a.contactId },
        h('div', { class: 'name' }, h('span', {}, timeOf(a.start) + ' · ' + a.name), h('span', { class: 'when' }, h('span', { class: 'status ' + a.status }, a.status))),
        h('div', { class: 'snip' }, calName(a.calendar)))));
    });
    m.appendChild(h('section', { class: 'card' }, h('h2', {}, 'Today’s appointments'), d.today.length ? list : h('p', { class: 'empty' }, 'Nothing booked today.')));
  }
  function stat(href, n, label) { return h('a', { class: 'stat', href: href }, h('b', {}, n), h('span', {}, label)); }

  // ---------- Inbox ----------

  async function inbox(_, seq) {
    var only = store('unreadOnly') === '1';
    var d = await api('/inbox' + (only ? '?unread=1' : ''));
    if (stale(seq)) return;
    var toggle = h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(only), on: { click: function () { store('unreadOnly', only ? '0' : '1'); route(); } } }, 'Unread only');
    var m = page('Inbox', toggle);
    if (!d.conversations.length) { m.appendChild(h('p', { class: 'empty' }, only ? 'No unread conversations.' : 'No conversations yet. Form submissions, replies and texts land here.')); return; }
    var list = h('ul', { class: 'list card' });
    d.conversations.forEach(function (c) {
      var icon = c.channel === 'sms' ? 'Text' : c.channel === 'form' ? 'Form' : 'Email';
      list.appendChild(h('li', {}, h('a', { class: 'item' + (c.unread ? ' unread' : ''), href: '#contact/' + c.contactId },
        h('div', { class: 'name' }, h('span', {}, c.name), c.unread ? h('span', { class: 'badge', 'aria-label': c.unread + ' unread' }, c.unread) : null, h('span', { class: 'when' }, ago(c.at))),
        h('div', { class: 'snip' }, icon + (c.direction === 'out' ? ' · You: ' : ' · ') + c.snippet))));
    });
    m.appendChild(list);
  }

  // ---------- Contacts ----------

  async function contacts(_, seq) {
    var q = h('input', { type: 'search', placeholder: 'Name, email or phone', 'aria-label': 'Search contacts', value: store('q') || '', class: 'grow' });
    var tag = h('input', { type: 'text', placeholder: 'Tag', 'aria-label': 'Filter by tag', value: store('tag') || '', size: 10 });
    var list = h('div', {});
    var err = errBox();
    var m = page('Contacts', h('button', { class: 'btn primary', type: 'button', on: { click: function () { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); } } }, 'Add contact'));
    var form = newContactForm();
    m.appendChild(form);
    m.appendChild(h('form', { class: 'row', role: 'search', on: { submit: function (e) { e.preventDefault(); load(); } } }, q, tag, h('button', { class: 'btn', type: 'submit' }, 'Search')));
    m.appendChild(err);
    m.appendChild(list);
    var timer;
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 250); });
    async function load() {
      store('q', q.value); store('tag', tag.value);
      try {
        var d = await api('/contacts?q=' + encodeURIComponent(q.value) + '&tag=' + encodeURIComponent(tag.value.trim().toLowerCase()));
        if (stale(seq)) return;
        clear(list);
        if (!d.contacts.length) { list.appendChild(h('p', { class: 'empty' }, 'No contacts match.')); return; }
        var ul = h('ul', { class: 'list card' });
        d.contacts.forEach(function (c) {
          ul.appendChild(h('li', {}, h('a', { class: 'item', href: '#contact/' + c.id },
            h('div', { class: 'name' }, h('span', {}, c.name), h('span', { class: 'when' }, c.active ? ago(c.active) : '')),
            h('div', { class: 'snip' }, [c.phone, c.email, c.source].filter(Boolean).join(' · ') + (c.tags.length ? ' · #' + c.tags.join(' #') : '')))));
        });
        list.appendChild(ul);
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    }
    await load();
  }

  function newContactForm() {
    var err = errBox();
    var f = {};
    ['first_name', 'last_name', 'email', 'phone'].forEach(function (k) {
      f[k] = h('input', { id: 'nc-' + k, name: k, type: k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text' });
    });
    var form = h('form', { class: 'card', hidden: true, on: { submit: act(err, async function () {
      var r = await api('/contact', { first_name: f.first_name.value, last_name: f.last_name.value, email: f.email.value, phone: f.phone.value });
      location.hash = '#contact/' + r.id;
    }) } },
      h('h2', {}, 'New contact'),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'f', for: 'nc-first_name' }, 'First name'), f.first_name),
        h('div', { class: 'grow' }, h('label', { class: 'f', for: 'nc-last_name' }, 'Last name'), f.last_name)),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'f', for: 'nc-email' }, 'Email'), f.email),
        h('div', { class: 'grow' }, h('label', { class: 'f', for: 'nc-phone' }, 'Phone'), f.phone)),
      err, h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Save contact')));
    return form;
  }

  // ---------- One contact ----------

  async function contact(idText, seq) {
    var id = Number(idText);
    var d = await api('/contact?id=' + id);
    if (stale(seq)) return;
    var c = d.contact;
    if (d.messages.some(function (m) { return m.direction === 'in' && !m.read_at; })) api('/read', { contact: id }).then(function () { refreshBadge('contacts'); }).catch(function () {});
    var reload = function () { if (!stale(seq)) contact(idText, ++S.seq); };
    var contactLine = h('div', { class: 'row muted' },
      c.phone ? h('a', { href: 'tel:' + c.phone }, c.phone) : null,
      c.email ? h('a', { href: 'mailto:' + c.email }, c.email) : null,
      c.source ? h('span', {}, 'Source: ' + c.source) : null);
    var m = page(c.name, h('a', { class: 'btn small', href: '#contacts' }, 'All contacts'));
    m.appendChild(contactLine);
    m.appendChild(h('div', { class: 'contact-grid' },
      h('div', {}, conversation(d, id, reload), timelineCard(d)),
      h('div', {}, oppsCard(d, id, reload), apptsCard(d, id, reload), tasksCard(d, id, reload), notesCard(d, id, reload), tagsCard(d, id, reload), fieldsCard(d, id, reload))));
    var t = m.querySelector('.thread');
    if (t) t.scrollTop = t.scrollHeight;
  }

  function conversation(d, id, reload) {
    var thread = h('div', { class: 'thread', role: 'log', 'aria-label': 'Conversation' });
    if (!d.messages.length) thread.appendChild(h('p', { class: 'empty' }, 'No messages yet.'));
    d.messages.forEach(function (msg) {
      var kind = msg.channel === 'form' ? 'form' : msg.direction;
      var bad = msg.status === 'failed' || msg.status === 'skipped';
      var who = msg.direction === 'in' ? (msg.channel === 'form' ? 'Form' : 'Them') : /^workflow:/.test(msg.author) ? 'Automation' : msg.author === 'system' ? 'Automatic' : msg.author;
      var label = (msg.channel === 'sms' ? 'Text' : msg.channel === 'form' ? 'Form submission' : 'Email') + ' · ' + who + ' · ' + when(msg.at)
        + (msg.direction === 'out' && msg.status === 'delivered' ? ' · delivered' : '');
      thread.appendChild(h('div', { class: 'bubble ' + kind + (bad ? ' bad' : '') },
        h('span', { class: 'meta' }, label),
        bad ? h('span', { class: 'meta err' }, (msg.status === 'skipped' ? 'Not sent: ' : 'Failed: ') + (msg.error || msg.status)) : null,
        msg.subject && msg.channel !== 'sms' ? h('span', { class: 'subj' }, msg.subject) : null,
        msg.body));
    });
    return h('section', { class: 'card' }, h('h2', {}, 'Conversation'), thread, composer(d, id, reload));
  }

  function composer(d, id, reload) {
    var smsReason = S.setup.sms ? d.canText : 'Texting isn’t set up for this business.';
    var channel = store('channel') === 'sms' && !smsReason ? 'sms' : (d.canEmail && !smsReason ? 'sms' : 'email');
    var err = errBox();
    var subject = h('input', { type: 'text', placeholder: 'Subject', 'aria-label': 'Subject', class: 'grow' });
    var body = h('textarea', { rows: 3, placeholder: 'Write a message', 'aria-label': 'Message' });
    var note = h('p', { class: 'muted' });
    var send = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
    var bEmail = h('button', { class: 'btn small', type: 'button', on: { click: function () { set('email'); } } }, 'Email');
    var bSms = h('button', { class: 'btn small', type: 'button', on: { click: function () { set('sms'); } } }, 'Text');
    function set(ch) {
      channel = ch;
      store('channel', ch);
      bEmail.setAttribute('aria-pressed', String(ch === 'email'));
      bSms.setAttribute('aria-pressed', String(ch === 'sms'));
      subject.hidden = ch !== 'email';
      var why = ch === 'email' ? d.canEmail : smsReason;
      note.textContent = why ? 'Can’t ' + (ch === 'email' ? 'email' : 'text') + ': ' + why + '.' : '';
      send.disabled = !!why;
      body.disabled = !!why;
    }
    set(channel);
    return h('form', { class: 'composer', on: { submit: act(err, async function () {
      await api('/message', { contact: id, channel: channel, subject: subject.value, body: body.value });
      reload();
    }) } }, h('div', { class: 'row', role: 'group', 'aria-label': 'Channel' }, bEmail, bSms), subject, body, note, err, h('div', { class: 'row' }, send));
  }

  function eventText(e) {
    var p = e.props || {};
    switch (e.name) {
      case 'Stage Changed': return 'Moved to ' + stageName(p.pipeline, p.stage) + (p.by ? ' by ' + by(p.by) : '');
      case 'Opportunity Status': return 'Marked ' + p.status + (p.reason ? ' (' + p.reason + ')' : '') + (p.by ? ' by ' + by(p.by) : '');
      case 'Tag Added': return 'Tag added: ' + p.tag;
      case 'Tag Removed': return 'Tag removed: ' + p.tag;
      case 'Appointment Booked': return 'Booked ' + calName(p.calendar) + ' for ' + when(p.start);
      case 'Appointment Status': return 'Appointment marked ' + p.status;
      case 'Workflow Step': return 'Automation ' + p.workflow + ', step ' + p.step + ' (' + p.action + '): ' + p.result;
      case 'Submitted Form': return 'Submitted form ' + p.form + (p.source ? ' (' + p.source + ')' : '');
      case 'Task Created': return 'Task: ' + p.title;
      case 'Contact Created': return 'Contact created' + (p.source ? ' from ' + p.source : '');
      default: return e.name;
    }
  }
  function by(who) { return /^workflow:/.test(who) ? 'automation' : who; }

  function timelineCard(d) {
    var ul = h('ul', { class: 'timeline' });
    d.events.forEach(function (e) { ul.appendChild(h('li', {}, h('span', { class: 'muted' }, when(e.at) + ' · '), eventText(e))); });
    return h('details', { class: 'card' }, h('summary', {}, 'Activity (' + d.events.length + ')'), d.events.length ? ul : h('p', { class: 'empty' }, 'Nothing yet.'));
  }

  function oppsCard(d, id, reload) {
    var err = errBox();
    var box = h('section', { class: 'card' }, h('h2', {}, 'Opportunities'), err);
    d.opportunities.forEach(function (o) {
      var pipe = S.setup.pipelines.find(function (p) { return p.id === o.pipeline; });
      var stage = h('select', { 'aria-label': 'Stage', disabled: o.status !== 'open', on: { change: act(err, async function () {
        await api('/opportunity', { id: o.id, contact: id, pipeline: o.pipeline, stage: stage.value }); reload();
      }) } }, (pipe ? pipe.stages : []).map(function (s) { return h('option', { value: s.id, selected: s.id === o.stage }, s.name); }));
      var value = h('input', { type: 'number', min: '0', step: '1', value: o.value, 'aria-label': 'Value in dollars', style: 'width:96px' });
      var reason = h('select', { 'aria-label': 'Lost reason' }, h('option', { value: '' }, 'Reason…'), (S.setup.lostReasons || []).map(function (r) { return h('option', { value: r }, r); }));
      var status = function (st) { return act(err, async function () { await api('/opportunity-status', { id: o.id, status: st, reason: st === 'lost' ? reason.value : '' }); reload(); }); };
      box.appendChild(h('div', { class: 'opp' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, (pipe ? pipe.name : o.pipeline) + (o.name ? ' · ' + o.name : '')), h('span', { class: 'status ' + o.status }, o.status)),
        h('div', { class: 'row' }, stage, value, h('button', { class: 'btn small', type: 'button', on: { click: act(err, async function () {
          await api('/opportunity', { id: o.id, contact: id, pipeline: o.pipeline, stage: o.stage, value: value.value }); reload();
        }) } }, 'Save value')),
        o.status === 'open'
          ? h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', on: { click: status('won') } }, 'Won'), reason, h('button', { class: 'btn small danger', type: 'button', on: { click: status('lost') } }, 'Lost'), h('button', { class: 'btn small', type: 'button', on: { click: status('abandoned') } }, 'Abandoned'))
          : h('div', { class: 'row' }, o.lost_reason ? h('span', { class: 'muted' }, o.lost_reason) : null, h('button', { class: 'btn small', type: 'button', on: { click: status('open') } }, 'Reopen'))));
    });
    if (S.setup.pipelines.length) {
      var pSel = h('select', { 'aria-label': 'Pipeline' }, S.setup.pipelines.map(function (p) { return h('option', { value: p.id }, p.name); }));
      var sSel = h('select', { 'aria-label': 'Stage' });
      var fill = function () {
        var p = S.setup.pipelines.find(function (x) { return x.id === pSel.value; });
        clear(sSel); p.stages.forEach(function (s) { sSel.appendChild(h('option', { value: s.id }, s.name)); });
      };
      pSel.addEventListener('change', fill);
      fill();
      box.appendChild(h('form', { class: 'row', on: { submit: act(err, async function () {
        await api('/opportunity', { contact: id, pipeline: pSel.value, stage: sSel.value }); reload();
      }) } }, pSel, sSel, h('button', { class: 'btn small', type: 'submit' }, 'Add to pipeline')));
    }
    return box;
  }

  var APPT_STATUSES = ['booked', 'confirmed', 'showed', 'noshow', 'cancelled'];
  var APPT_LABEL = { booked: 'Booked', confirmed: 'Confirmed', showed: 'Showed', noshow: 'No-show', cancelled: 'Cancel' };

  function apptStatusButtons(a, err, after) {
    return h('div', { class: 'row', role: 'group', 'aria-label': 'Appointment status' }, APPT_STATUSES.map(function (st) {
      return h('button', { class: 'btn small' + (st === 'cancelled' ? ' danger' : ''), type: 'button', 'aria-pressed': String(a.status === st), on: { click: act(err, async function () {
        await api('/appointment-status', { id: a.id, status: st }); after();
      }) } }, APPT_LABEL[st]);
    }));
  }

  function apptsCard(d, id, reload) {
    var err = errBox();
    var box = h('section', { class: 'card' }, h('h2', {}, h('span', { class: 'grow' }, 'Appointments')), err);
    d.appointments.forEach(function (a) {
      box.appendChild(h('div', { class: 'appt' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, calName(a.calendar) + ' · ' + when(a.start_at)), h('span', { class: 'status ' + a.status }, a.status)),
        a.notes ? h('p', { class: 'muted' }, a.notes) : null,
        apptStatusButtons({ id: Number(a.id), status: a.status }, err, reload)));
    });
    if ((S.setup.calendars || []).length) box.appendChild(booker(id, reload));
    return box;
  }

  /** Pick a calendar, a day and an open slot, or any time at all. */
  function booker(id, reload) {
    var err = errBox();
    var cal = h('select', { 'aria-label': 'Calendar' }, S.setup.calendars.map(function (c) { return h('option', { value: c.id }, c.name); }));
    var days = h('div', { class: 'row', role: 'group', 'aria-label': 'Day' });
    var slots = h('div', { class: 'slots', role: 'group', 'aria-label': 'Time' });
    var any = h('input', { type: 'datetime-local', 'aria-label': 'Any date and time' });
    var panel = h('div', { hidden: true },
      h('div', { class: 'row' }, cal, h('button', { class: 'btn small', type: 'button', on: { click: act(err, load) } }, 'Show open times')),
      days, slots,
      h('div', { class: 'row' }, h('label', { class: 'muted' }, 'Or any time: ', any), h('button', { class: 'btn small', type: 'button', on: { click: act(err, async function () {
        if (!any.value) throw new Error('Pick a date and time.');
        await api('/appointment', { contact: id, calendar: cal.value, start: zoned(any.value), anyTime: true }); reload();
      }) } }, 'Book at that time')), err);
    async function load() {
      clear(days); clear(slots);
      var r = await api('/slots?calendar=' + encodeURIComponent(cal.value));
      var ds = Object.keys(r.slots);
      if (!ds.length) { days.appendChild(h('span', { class: 'muted' }, 'No open times in the next two weeks.')); return; }
      ds.forEach(function (date, i) {
        var b = h('button', { class: 'btn small', type: 'button', on: { click: function () { show(date, b); } } }, fmt(r.slots[date][0], { weekday: 'short', month: 'short', day: 'numeric' }));
        days.appendChild(b);
        if (i === 0) show(date, b);
      });
      function show(date, b) {
        [].forEach.call(days.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        clear(slots);
        r.slots[date].forEach(function (s) {
          slots.appendChild(h('button', { class: 'btn small', type: 'button', on: { click: act(err, async function () {
            await api('/appointment', { contact: id, calendar: cal.value, start: s }); reload();
          }) } }, timeOf(s)));
        });
      }
    }
    return h('div', {}, h('button', { class: 'btn small', type: 'button', on: { click: function (e) { panel.hidden = !panel.hidden; e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) act(err, load)(); } }, 'aria-expanded': 'false' }, 'Book an appointment'), panel);
  }

  function taskRow(t, err, after, showContact) {
    var overdue = !t.done && t.due && new Date(t.due) < new Date();
    var box = h('input', { type: 'checkbox', checked: !!t.done, 'aria-label': 'Done: ' + t.title, on: { change: act(err, async function () {
      await api('/task-done', { id: t.id, done: box.checked }); after();
    }) } });
    return h('div', { class: 'task' + (overdue ? ' overdue' : '') + (t.done ? ' done' : '') }, box,
      h('div', { class: 't-body' }, h('div', { class: 't-title' }, t.title),
        t.body ? h('div', { class: 'muted' }, t.body) : null,
        h('div', { class: 'muted' }, (t.due ? (overdue ? 'Overdue · due ' : 'Due ') + when(t.due) : 'No due date'),
          showContact && t.contactId ? [' · ', h('a', { href: '#contact/' + t.contactId }, t.name)] : null)));
  }

  function tasksCard(d, id, reload) {
    var err = errBox();
    var title = h('input', { type: 'text', placeholder: 'New task', 'aria-label': 'New task', class: 'grow', required: true });
    var due = h('input', { type: 'datetime-local', 'aria-label': 'Due' });
    var box = h('section', { class: 'card' }, h('h2', {}, 'Tasks'), err);
    d.tasks.forEach(function (t) { box.appendChild(taskRow({ id: t.id, title: t.title, body: t.body, due: t.due_at, done: t.done_at }, err, reload, false)); });
    box.appendChild(h('form', { class: 'row', on: { submit: act(err, async function () {
      await api('/task', { contact: id, title: title.value, due: zoned(due.value) }); reload();
    }) } }, title, due, h('button', { class: 'btn small', type: 'submit' }, 'Add')));
    return box;
  }

  function notesCard(d, id, reload) {
    var err = errBox();
    var body = h('textarea', { rows: 2, placeholder: 'Add a note', 'aria-label': 'New note', required: true });
    var box = h('section', { class: 'card' }, h('h2', {}, 'Notes'));
    d.notes.forEach(function (n) {
      box.appendChild(h('div', { class: 'opp' }, h('div', { class: 'muted' }, when(n.at) + ' · ' + n.author), h('div', { style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, n.body)));
    });
    box.appendChild(h('form', { on: { submit: act(err, async function () { await api('/note', { contact: id, body: body.value }); reload(); }) } },
      body, err, h('button', { class: 'btn small', type: 'submit' }, 'Save note')));
    return box;
  }

  function tagsCard(d, id, reload) {
    var err = errBox();
    var input = h('input', { type: 'text', placeholder: 'Add a tag', 'aria-label': 'Add a tag', class: 'grow', required: true });
    var chips = h('div', {});
    (d.contact.tags || []).forEach(function (t) {
      chips.appendChild(h('span', { class: 'chip' }, t, h('button', { type: 'button', 'aria-label': 'Remove tag ' + t, on: { click: act(err, async function () {
        await api('/tag', { contact: id, tag: t, remove: true }); reload();
      }) } }, '×')));
    });
    return h('section', { class: 'card' }, h('h2', {}, 'Tags'), chips,
      h('form', { class: 'row', on: { submit: act(err, async function () { await api('/tag', { contact: id, tag: input.value }); reload(); }) } }, input, h('button', { class: 'btn small', type: 'submit' }, 'Add')), err);
  }

  function fieldsCard(d, id, reload) {
    var c = d.contact;
    var err = errBox(), ok = h('p', { class: 'ok', role: 'status', hidden: true });
    var f = {};
    var rows = [['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['source', 'Source']].map(function (x) {
      f[x[0]] = h('input', { id: 'cf-' + x[0], type: x[0] === 'email' ? 'email' : x[0] === 'phone' ? 'tel' : 'text', value: c[x[0]] || '' });
      return [h('label', { class: 'f', for: 'cf-' + x[0] }, x[1]), f[x[0]]];
    });
    var custom = {};
    (S.setup.customFields || []).forEach(function (cf) {
      var v = (c.custom || {})[cf.key] || '';
      var input = cf.type === 'select'
        ? h('select', { id: 'cx-' + cf.key }, h('option', { value: '' }, '—'), cf.options.map(function (o) { return h('option', { value: o, selected: o === v }, o); }))
        : cf.type === 'textarea' ? h('textarea', { id: 'cx-' + cf.key, rows: 2, value: v })
          : h('input', { id: 'cx-' + cf.key, type: cf.type === 'number' ? 'number' : cf.type === 'date' ? 'date' : 'text', value: v });
      custom[cf.key] = input;
      rows.push([h('label', { class: 'f', for: 'cx-' + cf.key }, cf.label), input]);
    });
    var status = h('p', { class: 'muted' }, 'Email: ' + c.emailStatus + ' · Texts: ' + c.smsStatus
      + (c.attribution && c.attribution.utm_source ? ' · Came from ' + c.attribution.utm_source : ''));
    return h('details', { class: 'card' }, h('summary', {}, 'Details'),
      h('form', { on: { submit: act(err, async function () {
        var body = { id: id, custom: {} };
        for (var k in f) body[k] = f[k].value;
        for (var key in custom) body.custom[key] = custom[key].value;
        await api('/contact', body);
        ok.textContent = 'Saved.'; ok.hidden = false;
        setTimeout(reload, 600);
      }) } }, rows, status, err, ok, h('button', { class: 'btn primary', type: 'submit' }, 'Save details')));
  }

  // ---------- Pipeline board ----------

  async function pipeline(_, seq) {
    var pipes = S.setup.pipelines;
    if (!pipes.length) { page('Pipeline').appendChild(h('p', { class: 'empty' }, 'No pipelines are set up yet.')); return; }
    var pid = store('pipeline:' + S.site);
    if (!pipes.some(function (p) { return p.id === pid; })) pid = pipes[0].id;
    var status = store('boardStatus') || 'open';
    var d = await api('/board?pipeline=' + encodeURIComponent(pid) + '&status=' + status);
    if (stale(seq)) return;
    var err = errBox();
    var pSel = h('select', { 'aria-label': 'Pipeline', on: { change: function () { store('pipeline:' + S.site, pSel.value); route(); } } },
      pipes.map(function (p) { return h('option', { value: p.id, selected: p.id === pid }, p.name); }));
    var stSel = h('select', { 'aria-label': 'Show', on: { change: function () { store('boardStatus', stSel.value); route(); } } },
      [['open', 'Open'], ['won', 'Won'], ['lost', 'Lost'], ['abandoned', 'Abandoned']].map(function (x) { return h('option', { value: x[0], selected: x[0] === status }, x[1]); }));
    var m = page('Pipeline', h('div', { class: 'row' }, pSel, stSel));
    m.appendChild(err);
    var board = h('div', { class: 'board' });
    var move = async function (o, stage) {
      if (stage === o.stage) return;
      try { await api('/opportunity', { id: o.id, contact: o.contactId, pipeline: pid, stage: stage }); route(); } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    var byId = {};
    d.opportunities.forEach(function (o) { byId[o.id] = o; });
    d.pipeline.stages.forEach(function (s) {
      var mine = d.opportunities.filter(function (o) { return o.stage === s.id; });
      var total = mine.reduce(function (n, o) { return n + o.value; }, 0);
      var col = h('section', { class: 'col', 'aria-label': s.name, on: {
        dragover: function (e) { if (status === 'open') { e.preventDefault(); col.classList.add('over'); } },
        dragleave: function () { col.classList.remove('over'); },
        drop: function (e) { e.preventDefault(); col.classList.remove('over'); var o = byId[e.dataTransfer.getData('text/plain')]; if (o) move(o, s.id); },
      } }, h('h2', {}, h('span', {}, s.name + ' (' + mine.length + ')'), total ? h('span', { class: 'muted' }, money(total)) : null));
      mine.forEach(function (o) {
        var sel = h('select', { 'aria-label': 'Move ' + o.contactName + ' to stage', disabled: status !== 'open', on: { change: function () { move(o, sel.value); } } },
          d.pipeline.stages.map(function (x) { return h('option', { value: x.id, selected: x.id === o.stage }, x.name); }));
        col.appendChild(h('div', { class: 'deal', draggable: status === 'open' ? 'true' : null, on: { dragstart: function (e) { e.dataTransfer.setData('text/plain', String(o.id)); } } },
          h('a', { href: '#contact/' + o.contactId }, o.name),
          h('div', { class: 'muted' }, [o.value ? money(o.value) : null, o.source, 'in stage ' + ago(o.stageAt)].filter(Boolean).join(' · ')),
          sel));
      });
      if (!mine.length) col.appendChild(h('p', { class: 'muted' }, 'Empty'));
      board.appendChild(col);
    });
    m.appendChild(board);
  }

  // ---------- Calendar ----------

  async function calendar(_, seq) {
    var from = store('calFrom:' + S.site);
    var today = localDate(new Date());
    if (!from || from < addDays(today, -60)) from = today;
    var d = await api('/calendar?from=' + from + '&days=7');
    if (stale(seq)) return;
    var err = errBox();
    var go = function (n) { store('calFrom:' + S.site, n === 0 ? today : addDays(from, n)); route(); };
    var m = page('Calendar', h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', on: { click: function () { go(-7); } } }, '‹ Previous'),
      h('button', { class: 'btn small', type: 'button', on: { click: function () { go(0); } } }, 'Today'),
      h('button', { class: 'btn small', type: 'button', on: { click: function () { go(7); } } }, 'Next ›')));
    m.appendChild(err);
    for (var i = 0; i < 7; i++) {
      var date = addDays(from, i);
      var appts = d.appointments.filter(function (a) { return localDate(a.start) === date; });
      var blocks = d.blocks.filter(function (b) { return localDate(b.start) <= date && localDate(new Date(new Date(b.end).getTime() - 1)) >= date; });
      var label = fmt(date + 'T12:00:00Z', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }) + (date === today ? ' · today' : '');
      var card = h('section', { class: 'card day' }, h('h2', {}, label));
      blocks.forEach(function (b) {
        card.appendChild(h('div', { class: 'appt-row block-row' }, h('span', { class: 'time' }, timeOf(b.start)),
          h('span', { class: 'who' }, 'Blocked until ' + when(b.end) + (b.calendar ? ' (' + calName(b.calendar) + ')' : '') + (b.reason ? ': ' + b.reason : '')),
          h('button', { class: 'btn small', type: 'button', on: { click: act(err, async function () { await api('/unblock', { id: b.id }); route(); }) } }, 'Remove')));
      });
      appts.forEach(function (a) {
        card.appendChild(h('div', { class: 'appt-row' }, h('span', { class: 'time' }, timeOf(a.start)),
          h('div', { class: 'who' }, h('a', { href: '#contact/' + a.contactId }, a.name), ' · ', calName(a.calendar),
            a.phone ? [' · ', h('a', { href: 'tel:' + a.phone }, a.phone)] : null, a.notes ? h('div', { class: 'muted' }, a.notes) : null),
          apptStatusButtons(a, err, route)));
      });
      if (!appts.length && !blocks.length) card.appendChild(h('p', { class: 'muted' }, 'Nothing booked.'));
      m.appendChild(card);
    }
    m.appendChild(blockForm(from, err));
  }

  function blockForm(from, outerErr) {
    var err = errBox();
    var cal = h('select', { id: 'bl-cal' }, h('option', { value: '' }, 'All calendars'), (S.setup.calendars || []).map(function (c) { return h('option', { value: c.id }, c.name); }));
    var start = h('input', { id: 'bl-start', type: 'datetime-local', required: true, value: from + 'T12:00' });
    var end = h('input', { id: 'bl-end', type: 'datetime-local', required: true, value: from + 'T13:00' });
    var reason = h('input', { id: 'bl-reason', type: 'text', placeholder: 'Lunch, holiday…' });
    return h('details', { class: 'card' }, h('summary', {}, 'Block off time'),
      h('form', { on: { submit: act(err, async function () {
        await api('/block', { calendar: cal.value, start: zoned(start.value), end: zoned(end.value), reason: reason.value }); route();
      }) } },
        h('label', { class: 'f', for: 'bl-cal' }, 'Calendar'), cal,
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'f', for: 'bl-start' }, 'From'), start), h('div', { class: 'grow' }, h('label', { class: 'f', for: 'bl-end' }, 'Until'), end)),
        h('label', { class: 'f', for: 'bl-reason' }, 'Reason (optional)'), reason, err,
        h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Block it'))));
  }

  // ---------- Tasks ----------

  async function tasks(_, seq) {
    var all = store('tasksAll') === '1';
    var d = await api('/tasks' + (all ? '?all=1' : ''));
    if (stale(seq)) return;
    var err = errBox();
    var m = page('Tasks', h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(all), on: { click: function () { store('tasksAll', all ? '0' : '1'); route(); } } }, 'Show done'));
    var title = h('input', { type: 'text', placeholder: 'New task (not tied to a contact)', 'aria-label': 'New task', class: 'grow', required: true });
    var due = h('input', { type: 'datetime-local', 'aria-label': 'Due' });
    m.appendChild(h('form', { class: 'row card', on: { submit: act(err, async function () { await api('/task', { title: title.value, due: zoned(due.value) }); route(); }) } },
      title, due, h('button', { class: 'btn small', type: 'submit' }, 'Add')));
    m.appendChild(err);
    var box = h('section', { class: 'card' });
    if (!d.tasks.length) box.appendChild(h('p', { class: 'empty' }, all ? 'No tasks yet.' : 'Nothing to do. Nice.'));
    d.tasks.forEach(function (t) { box.appendChild(taskRow(t, err, route, true)); });
    m.appendChild(box);
  }

  // ---------- start ----------

  async function start() {
    try {
      S.me = await api('/me');
    } catch (e) {
      if (!S.me) return; // signin() already drew the form
    }
    S.sites = S.me.sites;
    if (!S.sites.length) { clear(root).appendChild(h('div', { class: 'signin' }, h('h1', {}, 'No business yet'), h('p', {}, 'Your email isn’t set up for any business.'))); return; }
    var want = new URL(location.href).searchParams.get('site') || store('site');
    await pickSite(S.sites.some(function (s) { return s.id === want; }) ? want : S.sites[0].id);
  }

  window.addEventListener('hashchange', route);
  start().catch(function (e) { clear(root).appendChild(h('p', { class: 'err' }, e.message)); });
})();
