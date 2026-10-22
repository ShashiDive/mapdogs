// Mapdogs admin pages (Phase 1, build step 5): Screener and Reviewer.
// Requirement IDs refer to the Phase 1 requirements document.
import * as api from './api.js';
import { makeZip, toCsv } from './zip.js';

const app = document.getElementById('app');

let me = null;               // { role, display_name }
let tab = null;
let handlers = {};
let flashMsg = null;
const counts = { screening: null, review: null };
const review = { queue: null, urls: {}, chooser: null, chooserDogs: [], chooserUrls: {}, rejecting: null };
const dogs = { search: '', list: null, urls: {}, openId: null, detail: null, detailUrls: {} };

const TABS = [
  ['screening', 'Screening', ['screener']],
  ['review', 'Review', ['screener', 'reviewer']],
  ['dogs', 'Dogs', ['screener', 'reviewer']],
  ['export', 'Export', ['screener', 'reviewer']],
  ['activity', 'Activity', ['screener', 'reviewer']],
];

const ANGLE = { face: 'Face', left: 'Left side', right: 'Right side', nose: 'Nose', full: 'Full body', other: 'Other' };
const FLAGS = [['', 'Not flagged'], ['blurry', 'Blurry'], ['multiple_dogs', 'Several dogs'], ['people_or_plates', 'People or number plates']];
const REASONS = ['Not a dog', 'Photo too poor', 'Duplicate', 'Inappropriate', 'Other'];
const ANSWER = { yes: 'yes', no: 'no', unsure: "can't see" };

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
}) : '');

const btn = (act, label, kind = 'primary', extra = '') =>
  `<button type="button" class="btn ${kind}" data-act="${act}" ${extra}>${label}</button>`;

const photosText = (n) => (n === 1 ? '1 photo' : `${n} photos`);

const dogLabel = (d) => (d ? `${esc(d.name || d.code)}${d.name ? ` (${esc(d.code)})` : ''}` : '');

function errorText(e) {
  const map = {
    network: "Couldn't reach the server. Check the internet connection and try again.",
    not_allowed: "This account isn't allowed to do that.",
    needs_dog: 'Choose which dog this is before approving.',
    wrong_status: 'Someone else already handled this one. The list has been refreshed.',
    dog_not_found: "That dog wasn't found. Check the ID, like PUN-0007.",
    same_dog: "That's the same dog.",
  };
  const msg = (e && e.message) || '';
  const key = Object.keys(map).find((k) => msg.includes(k) || (e && e.code === k));
  return key ? map[key] : `Something went wrong: ${esc(msg || 'unknown error')}`;
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = handlers[el.dataset.act];
  if (fn) { e.preventDefault(); run(() => fn(el, e)); }
});
app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && handlers[el.dataset.change]) run(() => handlers[el.dataset.change](el, e));
});
app.addEventListener('keydown', (e) => {
  const el = e.target.closest('[data-enter]');
  if (el && e.key === 'Enter' && handlers[el.dataset.enter]) { e.preventDefault(); run(() => handlers[el.dataset.enter](el, e)); }
});

// Runs an action, showing any failure at the top of the page.
async function run(fn) {
  try {
    await fn();
  } catch (e) {
    if (!me) return showLogin(errorText(e));
    flashMsg = { kind: 'error', text: errorText(e) };
    if (String(e && e.message).includes('wrong_status')) { review.queue = null; }
    showTab(tab);
  }
}

function flash(text) { flashMsg = { kind: 'ok', text }; }

// ---------------------------------------------------------------------
// Page frame
// ---------------------------------------------------------------------

function render(content, h = {}) {
  handlers = {
    tab: (el) => showTab(el.dataset.value),
    signout: async () => { await api.sb.auth.signOut(); me = null; showLogin(); },
    dismiss: () => { flashMsg = null; app.querySelector('.flash')?.remove(); },
    ...h,
  };
  const tabs = TABS.filter(([, , roles]) => roles.includes(me.role));
  const f = flashMsg;
  if (content !== LOADING) flashMsg = null;   // keep messages through the loading spinner
  app.innerHTML = `<main class="admin-screen">
    <header class="admin-head">
      <div><h1>Mapdogs admin</h1>
        <p class="hint">${esc(me.display_name)}, ${me.role === 'screener' ? 'Screener' : 'Reviewer'}</p></div>
      ${btn('signout', 'Sign out', 'small')}
    </header>
    <nav class="tabs">${tabs.map(([k, label]) => `<button type="button" class="tab${k === tab ? ' on' : ''}" data-act="tab" data-value="${k}" aria-pressed="${k === tab}">${label}${counts[k] != null ? ` <span class="tab-count">${counts[k]}</span>` : ''}</button>`).join('')}</nav>
    ${f ? `<p class="flash ${f.kind}" role="status">${f.text} <button type="button" class="flash-x" data-act="dismiss" aria-label="Dismiss">×</button></p>` : ''}
    <section class="admin-content">${content}</section>
  </main>`;
}

const LOADING = '<div class="busy inline"><span class="spinner" aria-hidden="true"></span></div>';
const loading = () => LOADING;

function showTab(name) {
  tab = name;
  ({ screening: showScreening, review: showReview, dogs: showDogs, export: showExport, activity: showActivity }[name] || showReview)();
}

// ---------------------------------------------------------------------
// Login (FR-30)
// ---------------------------------------------------------------------

function showLogin(message = '') {
  handlers = { login: doLogin };
  app.innerHTML = `<main class="screen">
    <section class="content">
      <h1>Mapdogs admin</h1>
      <p class="lead">For the Screener and Reviewer only.</p>
      <label class="field"><span>Email</span><input id="email" type="email" autocomplete="username" data-enter="login"></label>
      <label class="field" style="margin-top:14px"><span>Password</span><input id="password" type="password" autocomplete="current-password" data-enter="login"></label>
      ${message ? `<p class="error" role="alert">${message}</p>` : ''}
    </section>
    <footer class="actions">${btn('login', 'Sign in')}</footer>
  </main>`;
}

async function doLogin() {
  const email = app.querySelector('#email').value.trim();
  const password = app.querySelector('#password').value;
  if (!email || !password) return showLogin('Enter your email and password.');
  const b = app.querySelector('[data-act="login"]');
  b.disabled = true;
  b.textContent = 'Signing in…';
  const { error } = await api.sb.auth.signInWithPassword({ email, password });
  if (error) return showLogin(/invalid/i.test(error.message) ? 'Wrong email or password.' : esc(error.message));
  await afterSignIn();
}

async function afterSignIn() {
  me = await api.rpc('admin_me');
  if (!me) {
    await api.sb.auth.signOut();
    return showLogin("This account isn't set up as an admin.");
  }
  await refreshCounts();
  showTab(me.role === 'screener' ? 'screening' : 'review');
}

async function refreshCounts() {
  try {
    if (me.role === 'screener') counts.screening = (await api.rpc('admin_queue', { p_status: 'screening' })).length;
    counts.review = (await api.rpc('admin_queue', { p_status: 'review' })).length;
  } catch (_) { /* counts are a nicety */ }
}

// ---------------------------------------------------------------------
// Sighting cards
// ---------------------------------------------------------------------

function choiceLabel(s) {
  const d = s.dog;
  if (s.choice === 'new') return `New dog: ${d ? dogLabel(d) : 'no dog record'}`;
  if (s.choice === 'known') return `Seen again: ${dogLabel(d)}`;
  if (s.choice === 'add_more') return `More photos of ${dogLabel(d)}`;
  return 'Not sure which dog';
}

function flagSelect(p) {
  const current = (p.flags && p.flags[0]) || '';
  return `<select class="flagsel" data-change="flag" data-id="${p.id}" aria-label="Flag this photo">
    ${FLAGS.map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${l}</option>`).join('')}
  </select>`;
}

function photoTile(p, urls, withFlag, extra = '') {
  const url = urls[p.path];
  const notes = [ANGLE[p.angle] || p.angle];
  if (p.quality_warning) notes.push(`looks ${p.quality_warning}`);
  if (p.source === 'gallery') notes.push('gallery');
  return `<figure class="ptile${p.hidden ? ' is-hidden' : ''}">
      ${url ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(notes[0])}" loading="lazy"></a>` : '<span class="ptile-missing">No preview</span>'}
      <figcaption>${notes.join(', ')}${p.hidden ? ' · <strong>hidden</strong>' : ''}</figcaption>
      ${withFlag ? flagSelect(p) : ''}${extra}
    </figure>`;
}

function facts(s) {
  const src = { live: 'phone location', exif: "photo's GPS", manual: 'pin dropped by hand' }[s.location_source] || s.location_source;
  const acc = s.accuracy_m != null ? `, about ${Math.round(s.accuracy_m)} m` : '';
  const checks = ['ear_notch', 'collar', 'injured']
    .filter((k) => s[k])
    .map((k) => `${{ ear_notch: 'Ear notch', collar: 'Collar', injured: 'Injured' }[k]}: ${ANSWER[s[k]] || s[k]}`);
  return `<ul class="facts">
      <li>From <strong>${esc(s.contributor.nickname)} #${esc(s.contributor.tag)}</strong>${s.contributor.blocked ? ' <span class="chip no">Blocked</span>' : ''}</li>
      <li>Sent ${when(s.created_at)}${Math.abs(new Date(s.captured_at) - new Date(s.created_at)) > 3600000 ? `, photo taken ${when(s.captured_at)}` : ''}</li>
      <li>Location from ${src}${acc}${s.accuracy_flag ? ' <span class="chip review">Rough location</span>' : ''}.
        <a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">Open the exact spot</a></li>
      ${checks.length ? `<li>${checks.join(', ')}${s.injured === 'yes' ? ' <span class="chip no">Needs help?</span>' : ''}</li>` : ''}
    </ul>`;
}

// ---------------------------------------------------------------------
// Screening (Screener only, FR-51, FR-52, FR-53)
// ---------------------------------------------------------------------

async function showScreening() {
  render(loading());
  const q = await api.rpc('admin_queue', { p_status: 'screening' });
  counts.screening = q.length;
  const urls = await api.photoUrls(q.flatMap((s) => s.photos.map((p) => p.path)));
  if (tab !== 'screening') return;
  if (!q.length) {
    return render('<p class="empty">Nothing to screen. New sightings arrive here first, before anyone else sees them.</p>');
  }
  render(`<div class="queue-head">
      <p><strong>${q.length}</strong> to screen, oldest first. Delete anything inappropriate, then clear the rest for review.</p>
      ${btn('clearall', `Clear all ${q.length} for review`)}
    </div>
    ${q.map((s) => `<article class="card">
        <div class="card-photos">${s.photos.map((p) => photoTile(p, urls, false)).join('')}</div>
        <div class="card-body">
          <p class="card-title">${choiceLabel(s)}</p>
          ${facts(s)}
          <div class="card-actions">
            ${btn('clear', 'Clear for review', 'secondary', `data-id="${s.id}"`)}
            ${btn('delete', 'Delete', 'danger', `data-id="${s.id}"`)}
            ${btn('block', s.contributor.blocked ? 'Unblock contributor' : 'Block contributor', 'ghost', `data-cid="${s.contributor.id}" data-blocked="${s.contributor.blocked}"`)}
          </div>
        </div>
      </article>`).join('')}`, {
    clearall: async (el) => {
      el.disabled = true;
      const n = await api.rpc('screen_clear', { p_ids: q.map((s) => s.id) });
      flash(`${n} cleared for review.`);
      review.queue = null;
      await refreshCounts();
      showScreening();
    },
    clear: async (el) => {
      el.disabled = true;
      await api.rpc('screen_clear', { p_ids: [el.dataset.id] });
      flash('Cleared for review.');
      review.queue = null;
      await refreshCounts();
      showScreening();
    },
    delete: async (el) => {
      if (!window.confirm('Delete this sighting and its photos? This cannot be undone.')) return;
      el.disabled = true;
      const paths = await api.rpc('screen_delete', { p_ids: [el.dataset.id] });
      await api.removePhotos(paths);
      flash('Sighting and photos deleted.');
      showScreening();
    },
    block: (el) => toggleBlock(el, showScreening),
  });
}

async function toggleBlock(el, after) {
  const blocking = el.dataset.blocked !== 'true';
  let reason = null;
  if (blocking) {
    reason = window.prompt("Block this contributor's phone from sending sightings? Optional: note why.", '');
    if (reason === null) return;
  }
  await api.rpc('admin_block_contributor', { p_contributor: el.dataset.cid, p_block: blocking, p_reason: reason });
  flash(blocking ? 'Contributor blocked.' : 'Contributor unblocked.');
  review.queue = null;
  after();
}

// ---------------------------------------------------------------------
// Review (FR-31, FR-32, FR-35)
// ---------------------------------------------------------------------

async function showReview() {
  if (!review.queue) {
    render(loading());
    review.queue = await api.rpc('admin_queue', { p_status: 'review' });
    review.urls = await api.photoUrls(review.queue.flatMap((s) => s.photos.map((p) => p.path)));
    counts.review = review.queue.length;
    if (tab !== 'review') return;
  }
  paintReview();
}

function chooserPanel(s) {
  return `<div class="chooser">
      <p class="label">Which dog is this?</p>
      <div class="searchrow">
        <input id="dogq" type="search" placeholder="Search by ID or name" data-enter="dogsearch">
        ${btn('dogsearch', 'Search', 'small')}
      </div>
      <div class="pick-list">${review.chooserDogs.length ? review.chooserDogs.map((d) => `
        <button type="button" class="pick" data-act="pickdog" data-dog="${d.id}">
          <span class="pick-img">${review.chooserUrls[d.thumb_path] ? `<img src="${review.chooserUrls[d.thumb_path]}" alt="">` : ''}</span>
          <span class="pick-text"><strong>${esc(d.name || d.code)}</strong>${d.name ? ` ${esc(d.code)}` : ''}
            <span class="sub-meta">${d.distance_m != null ? `${d.distance_m} m away, ` : ''}${photosText(d.photo_count)}, ${d.status}</span></span>
        </button>`).join('') : '<p class="empty">No dogs found.</p>'}</div>
      <div class="searchrow">
        <input id="newname" type="text" maxlength="40" placeholder="Name for a new dog (optional)">
        ${btn('newdog', 'New dog', 'small', `data-id="${s.id}"`)}
      </div>
      ${btn('closechooser', 'Cancel', 'ghost')}
    </div>`;
}

function paintReview() {
  const q = review.queue;
  if (!q.length) {
    return render('<p class="empty">Nothing to review. Sightings arrive here once the Screener clears them.</p>');
  }
  render(`<div class="queue-head"><p><strong>${q.length}</strong> to review, oldest first. Check the dog, flag poor photos, then approve or reject.</p></div>
    ${q.map((s) => `<article class="card" id="s-${s.id}">
        <div class="card-photos">${s.photos.map((p) => photoTile(p, review.urls, true)).join('')}</div>
        <div class="card-body">
          <p class="card-title">${choiceLabel(s)}</p>
          ${facts(s)}
          <div class="dogrow">
            ${s.dog ? `<span>Dog: <strong>${dogLabel(s.dog)}</strong></span>` : '<span class="chip review">No dog chosen yet</span>'}
            ${btn('openchooser', s.dog ? 'Change dog' : 'Choose dog', 'small', `data-id="${s.id}"`)}
          </div>
          ${review.chooser === s.id ? chooserPanel(s) : ''}
          ${review.rejecting === s.id ? `<div class="reasons"><p class="label">Reason for rejecting</p>
              <div class="chiprow">${REASONS.map((r) => `<button type="button" class="fchip" data-act="reject" data-id="${s.id}" data-reason="${esc(r)}">${r}</button>`).join('')}</div>
              ${btn('cancelreject', 'Cancel', 'ghost')}</div>` : `
          <div class="card-actions">
            ${btn('approve', 'Approve', 'primary', `data-id="${s.id}"${s.dog ? '' : ' disabled'}`)}
            ${btn('startreject', 'Reject', 'secondary', `data-id="${s.id}"`)}
            ${btn('block', s.contributor.blocked ? 'Unblock contributor' : 'Block contributor', 'ghost', `data-cid="${s.contributor.id}" data-blocked="${s.contributor.blocked}"`)}
          </div>`}
        </div>
      </article>`).join('')}`, {
    flag: async (el) => {
      await api.rpc('admin_flag_photo', { p_photo: el.dataset.id, p_flags: el.value ? [el.value] : [] });
      for (const s of q) for (const p of s.photos) if (p.id === el.dataset.id) { p.flags = el.value ? [el.value] : []; p.hidden = !!el.value; }
      flash(el.value ? 'Photo flagged and hidden from the public.' : 'Flag removed.');
      paintReview();
    },
    openchooser: async (el) => {
      const s = q.find((x) => x.id === el.dataset.id);
      review.chooser = s.id;
      review.rejecting = null;
      review.chooserDogs = await api.rpc('admin_dogs', { p_search: null, p_lat: s.lat, p_lng: s.lng });
      review.chooserUrls = await api.photoUrls(review.chooserDogs.map((d) => d.thumb_path));
      paintReview();
      document.getElementById(`s-${s.id}`)?.scrollIntoView({ block: 'start' });
    },
    dogsearch: async () => {
      const term = app.querySelector('#dogq').value.trim();
      const s = q.find((x) => x.id === review.chooser);
      review.chooserDogs = await api.rpc('admin_dogs', term
        ? { p_search: term, p_lat: s.lat, p_lng: s.lng } : { p_search: null, p_lat: s.lat, p_lng: s.lng });
      review.chooserUrls = await api.photoUrls(review.chooserDogs.map((d) => d.thumb_path));
      paintReview();
      const input = app.querySelector('#dogq');
      if (input) { input.value = term; }
    },
    pickdog: async (el) => setDog(Number(el.dataset.dog), null),
    newdog: async () => setDog(null, app.querySelector('#newname').value.trim()),
    closechooser: () => { review.chooser = null; paintReview(); },
    approve: async (el) => {
      el.disabled = true;
      await api.rpc('review_approve', { p_id: el.dataset.id });
      review.queue = q.filter((s) => s.id !== el.dataset.id);
      counts.review = review.queue.length;
      flash('Approved. It now shows on the public map.');
      paintReview();
    },
    startreject: (el) => { review.rejecting = el.dataset.id; review.chooser = null; paintReview(); },
    cancelreject: () => { review.rejecting = null; paintReview(); },
    reject: async (el) => {
      await api.rpc('review_reject', { p_id: el.dataset.id, p_reason: el.dataset.reason });
      review.queue = q.filter((s) => s.id !== el.dataset.id);
      review.rejecting = null;
      counts.review = review.queue.length;
      flash('Rejected. The contributor sees the reason in My contributions.');
      paintReview();
    },
    block: (el) => toggleBlock(el, showReview),
  });
}

async function setDog(dogId, newName) {
  const updated = await api.rpc('admin_set_dog', { p_submission: review.chooser, p_dog: dogId, p_new_name: newName });
  review.queue = review.queue.map((s) => (s.id === updated.id ? updated : s));
  review.chooser = null;
  flash(`Dog set to ${dogLabel(updated.dog)}.`);
  paintReview();
}

// ---------------------------------------------------------------------
// Dogs: search, edit, merge, move and flag photos (FR-31, FR-33, FR-34, FR-35)
// ---------------------------------------------------------------------

async function showDogs() {
  if (dogs.openId) return showDog(dogs.openId);
  if (!dogs.list) {
    render(loading());
    dogs.list = await api.rpc('admin_dogs', { p_search: dogs.search || null });
    dogs.urls = await api.photoUrls(dogs.list.map((d) => d.thumb_path));
    if (tab !== 'dogs') return;
  }
  render(`<div class="searchrow">
      <input id="dsearch" type="search" placeholder="Search by ID or name" value="${esc(dogs.search)}" data-enter="search">
      ${btn('search', 'Search', 'small')}
    </div>
    <div class="pick-list">${dogs.list.length ? dogs.list.map((d) => `
      <button type="button" class="pick" data-act="open" data-dog="${d.id}">
        <span class="pick-img">${dogs.urls[d.thumb_path] ? `<img src="${dogs.urls[d.thumb_path]}" alt="">` : ''}</span>
        <span class="pick-text"><strong>${esc(d.name || d.code)}</strong>${d.name ? ` ${esc(d.code)}` : ''}
          <span class="sub-meta">${photosText(d.photo_count)}, ${d.status}${d.last_seen_at ? `, last seen ${when(d.last_seen_at)}` : ''}</span></span>
      </button>`).join('') : '<p class="empty">No dogs found.</p>'}</div>`, {
    search: async () => {
      dogs.search = app.querySelector('#dsearch').value.trim();
      dogs.list = null;
      showDogs();
    },
    open: (el) => showDog(Number(el.dataset.dog)),
  });
}

async function findDogByCode(input) {
  const code = input.trim().toUpperCase();
  const found = await api.rpc('admin_dogs', { p_search: code });
  const dog = found.find((d) => d.code.toUpperCase() === code);
  if (!dog) throw Object.assign(new Error('dog_not_found'), { code: 'dog_not_found' });
  return dog;
}

async function showDog(id) {
  dogs.openId = id;
  render(loading());
  const d = await api.rpc('admin_dog_detail', { p_dog: id });
  if (!d) { dogs.openId = null; dogs.list = null; return showDogs(); }
  const urls = await api.photoUrls(d.photos.map((p) => p.path));
  if (tab !== 'dogs') return;
  const opt = (v, l, cur) => `<option value="${v}"${v === (cur || '') ? ' selected' : ''}>${l}</option>`;
  render(`${btn('alldogs', '‹ All dogs', 'ghost left')}
    <h2 class="dog-h">${esc(d.name || d.code)}${d.name ? ` <span class="sub-meta">${esc(d.code)}</span>` : ''}
      <span class="chip ${d.status === 'approved' ? 'ok' : d.status === 'pending' ? 'review' : 'no'}">${d.status}</span></h2>
    <div class="form-grid">
      <label class="field"><span>Name</span><input id="dname" type="text" maxlength="40" value="${esc(d.name)}"></label>
      <label class="field"><span>Sex</span><select id="dsex">${opt('', 'Not recorded', d.sex)}${opt('male', 'Male', d.sex)}${opt('female', 'Female', d.sex)}${opt('unknown', 'Not sure', d.sex)}</select></label>
      <label class="field"><span>Age group</span><select id="dage">${opt('', 'Not recorded', d.age_group)}${opt('puppy', 'Puppy', d.age_group)}${opt('adult', 'Adult', d.age_group)}${opt('senior', 'Senior', d.age_group)}</select></label>
      <label class="field wide"><span>Notes</span><textarea id="dnotes" maxlength="280" rows="2">${esc(d.notes)}</textarea></label>
    </div>
    <div class="card-actions">${btn('save', 'Save details')}${btn('merge', 'Merge a duplicate into this dog', 'secondary')}</div>
    <p class="label">${photosText(d.photos.length)}, newest first</p>
    <div class="photo-grid">${d.photos.map((p) => photoTile(p, urls, true,
      `<p class="sub-meta">${esc(p.contributor)}, ${when(p.created_at)}, ${p.submission_status}</p>${btn('move', 'Move to another dog', 'small', `data-id="${p.id}"`)}`)).join('')}</div>`, {
    alldogs: () => { dogs.openId = null; dogs.list = null; showDogs(); },
    save: async () => {
      await api.rpc('admin_update_dog', {
        p_dog: id,
        p: {
          name: app.querySelector('#dname').value,
          sex: app.querySelector('#dsex').value,
          age_group: app.querySelector('#dage').value,
          notes: app.querySelector('#dnotes').value,
        },
      });
      flash('Details saved.');
      showDog(id);
    },
    merge: async () => {
      const code = window.prompt(`Which dog is a duplicate of ${d.code}? Type its ID, like PUN-0007. Its photos move here and its record is retired.`, '');
      if (!code) return;
      const dup = await findDogByCode(code);
      if (!window.confirm(`Merge ${dup.code}${dup.name ? ` (${dup.name})` : ''} into ${d.code}? This cannot be undone in Phase 1.`)) return;
      await api.rpc('admin_merge_dogs', { p_from: dup.id, p_into: id });
      flash(`${dup.code} merged into ${d.code}.`);
      showDog(id);
    },
    move: async (el) => {
      const code = window.prompt('Move this photo to which dog? Type its ID, like PUN-0007, or leave it empty to start a new dog.', '');
      if (code === null) return;
      let target = null;
      if (code.trim()) target = (await findDogByCode(code)).id;
      const newId = await api.rpc('admin_move_photo', { p_photo: el.dataset.id, p_dog: target, p_new_name: null });
      flash(target ? 'Photo moved.' : 'Photo moved to a new dog.');
      showDog(target ? id : newId);
    },
    flag: async (el) => {
      await api.rpc('admin_flag_photo', { p_photo: el.dataset.id, p_flags: el.value ? [el.value] : [] });
      flash(el.value ? 'Photo flagged and hidden from the public.' : 'Flag removed.');
      showDog(id);
    },
  });
}

// ---------------------------------------------------------------------
// Export (FR-38, FR-39)
// ---------------------------------------------------------------------

function showExport() {
  render(`<h2 class="dog-h">Download everything</h2>
    <p>One ZIP file with <code>dogs.csv</code>, <code>photos.csv</code> and every photo in a folder per dog ID.
      Photos not yet linked to a dog go in <code>photos/unassigned</code>. Hidden photos are included and marked in the flags column.
      Deleted sightings are left out.</p>
    <p class="hint">Contains exact locations: keep the file private. Take one at least weekly as a backup (NFR-19).</p>
    <div class="card-actions">${btn('zip', 'Download ZIP')}</div>
    <p id="zipstatus" class="hint" role="status"></p>`, { zip: buildExport });
}

async function buildExport(el) {
  el.disabled = true;
  const status = (t) => { const s = app.querySelector('#zipstatus'); if (s) s.textContent = t; };
  status('Collecting records…');
  const data = await api.rpc('admin_export');
  const files = [
    { name: 'dogs.csv', data: toCsv(data.dogs) },
    { name: 'photos.csv', data: toCsv(data.photos.map(({ path, ...rest }) => rest)) },
  ];
  let done = 0;
  let missing = 0;
  const total = data.photos.length;
  for (let i = 0; i < total; i += 50) {
    const batch = data.photos.slice(i, i + 50);
    const urls = await api.photoUrls(batch.map((p) => p.path));
    await Promise.all(batch.map(async (p) => {
      try {
        const res = await fetch(urls[p.path]);
        if (!res.ok) throw new Error('missing');
        files.push({ name: `photos/${p.dog_id || 'unassigned'}/${p.photo_id}.jpg`, data: new Uint8Array(await res.arrayBuffer()) });
      } catch (_) {
        missing++;
      }
      done++;
      status(`Downloading photo ${done} of ${total}…`);
    }));
  }
  status('Building the ZIP file…');
  const blob = makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mapdogs-export-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  status(`Done: ${data.dogs.length} dogs, ${total - missing} photos${missing ? `, ${missing} photo files could not be found` : ''}.`);
  el.disabled = false;
}

// ---------------------------------------------------------------------
// Activity (FR-36)
// ---------------------------------------------------------------------

const ACTION = {
  screen_clear: 'Cleared for review', screen_delete: 'Deleted sighting', approve: 'Approved', reject: 'Rejected',
  set_dog: 'Chose dog', merge: 'Merged dogs', move_photo: 'Moved photo', flag_photo: 'Flagged photo',
  edit_dog: 'Edited dog', block: 'Blocked contributor', unblock: 'Unblocked contributor',
};

async function showActivity() {
  render(loading());
  const rows = await api.rpc('admin_activity', { p_limit: 100 });
  if (tab !== 'activity') return;
  render(rows.length ? `<table class="log">
      <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${when(r.created_at)}</td><td>${esc(r.admin)}</td>
        <td>${esc(ACTION[r.action] || r.action)}${r.details && r.details.reason ? `: ${esc(r.details.reason)}` : ''}</td></tr>`).join('')}</tbody>
    </table>` : '<p class="empty">No admin actions yet.</p>');
}

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

async function init() {
  if (!api.configured) {
    app.innerHTML = '<main class="screen"><h1>Setup needed</h1><p class="lead">Add the Supabase Project URL and publishable key to config.js.</p></main>';
    return;
  }
  const session = await api.getSession();
  if (session && !session.user.is_anonymous) {
    try { return await afterSignIn(); } catch (_) { /* fall through to login */ }
  }
  showLogin();
}

init();
