// Mapdogs contributor flow (Phase 1). Screens follow journeys 5.1 and 5.2
// of the requirements document; requirement IDs are noted where they apply.
import { t, setLanguage } from './strings.js';
import * as api from './api.js';
import { prepPhoto, getLiveLocation, loadLeaflet } from './photo.js';

const app = document.getElementById('app');
const camInput = document.getElementById('cam-input');
const galInput = document.getElementById('gal-input');

const KEY = { consent: 'md_consent', locAsked: 'md_loc_asked', lastLoc: 'md_last_loc', lang: 'md_lang' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
};

const PUNE = { lat: 18.5204, lng: 73.8567 };
const ANGLES = ['face', 'left', 'right', 'nose', 'full', 'other'];
const SUGGESTED = ['face', 'left', 'right', 'nose', 'full'];

let profile = null;     // contributor profile from the database
let draft = null;       // the sighting being made
let afterConsent = 'nickname';
let handlers = {};
let mapInstance = null;

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function ago(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return t('today');
  if (days === 1) return t('yesterday');
  if (days < 30) return t('days_ago', { n: days });
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const dogLabel = (dog) => (dog && (dog.name || dog.dog_name)) || (dog && (dog.code || dog.dog_code)) || '';

function errorText(e) {
  const map = {
    network: 'err_network', rate_limited: 'err_rate', blocked: 'err_blocked',
    too_many_attempts: 'err_too_many', signin: 'err_signin',
  };
  return t(map[e && e.code] || 'err_generic');
}

// ---------------------------------------------------------------------
// Navigation: a stack of screens, tied to the phone's Back button
// ---------------------------------------------------------------------

const stack = [];
const NO_BACK = new Set(['processing', 'locating', 'uploading']);

function go(name, opts = {}) {
  if (opts.home) { stack.length = 0; stack.push('home'); }
  if (opts.reset) stack.length = 0;
  if (opts.replace && stack.length) {
    stack[stack.length - 1] = name;
    history.replaceState({ md: stack.length }, '');
  } else {
    stack.push(name);
    history.pushState({ md: stack.length }, '');
  }
  show(name);
}

function back() {
  history.back();
}

window.addEventListener('popstate', () => {
  const current = stack[stack.length - 1];
  if (NO_BACK.has(current)) {
    history.pushState({ md: stack.length }, '');
    return;
  }
  if (stack.length > 1) {
    stack.pop();
    show(stack[stack.length - 1]);
  }
});

function show(name) {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  if (name === 'map') mapState.data = null;   // fresh data each visit, so new sightings show at once
  (screens[name] || screens.home)();
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = el.dataset.act === 'back' ? back : handlers[el.dataset.act];
  if (fn) fn(el, e);
});

// ---------------------------------------------------------------------
// Page building blocks
// ---------------------------------------------------------------------

function progressBar(step) {
  if (!step) return '';
  const total = draft && draft.choice === 'new' ? 4 : 3;
  const labels = ['', t('step_photos'), t('step_which'), t('step_checks'), t('step_details')];
  const n = Math.min(step, total);
  return `<div class="progress" role="progressbar" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${n}">
      <div class="progress-track"><span style="width:${(n / total) * 100}%"></span></div>
      <span class="progress-label">${t('step', { n, total })}: ${labels[step]}</span>
    </div>`;
}

function page({ title = '', lead = '', body = '', actions = '', showBack = true, step = 0, cls = '' }) {
  const canBack = showBack && stack.length > 1;
  return `<main class="screen ${cls}">
    <header class="bar">
      ${canBack ? `<button class="back" data-act="back" type="button">‹ ${t('back')}</button>` : ''}
      ${progressBar(step)}
    </header>
    <section class="content">
      ${title ? `<h1>${title}</h1>` : ''}
      ${lead ? `<p class="lead">${lead}</p>` : ''}
      ${body}
    </section>
    ${actions ? `<footer class="actions">${actions}</footer>` : ''}
  </main>`;
}

const button = (act, label, kind = 'primary', extra = '') =>
  `<button type="button" class="btn ${kind}" data-act="${act}" ${extra}>${label}</button>`;

// Large radio-style choices that move on when tapped (NFR-23).
const choices = (act, items) => `<div class="choices" role="list">
  ${items.map((it) => `<button type="button" role="listitem" class="choice${it.done ? ' done' : ''}" data-act="${act}" data-value="${esc(it.value)}">
      <span class="choice-label">${it.label}</span>${it.sub ? `<span class="choice-sub">${it.sub}</span>` : ''}
    </button>`).join('')}
</div>`;

function render(html, h = {}) {
  handlers = h;
  app.innerHTML = html;
  window.scrollTo(0, 0);
  const h1 = app.querySelector('h1');
  if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
}

function busy(message) {
  render(page({ showBack: false, body: `<div class="busy"><span class="spinner" aria-hidden="true"></span><p>${message}</p></div>` }));
}

function showError(err, retry) {
  render(page({
    showBack: false,
    title: t('err_title'),
    lead: errorText(err),
    actions: (retry ? button('retry', t('try_again')) : '') + button('home', t('home'), retry ? 'secondary' : 'primary'),
  }), {
    retry: () => retry(),
    home: () => goHome(),
  });
}

function dogTag(code, extraClass = '') {
  return `<div class="dogtag ${extraClass}"><span class="dogtag-hole" aria-hidden="true"></span><span class="dogtag-code">${esc(code)}</span></div>`;
}

// ---------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------

const screens = {};

screens.setup = () => render(page({ showBack: false, title: t('setup_title'), lead: t('setup_lead') }));

// Welcome (FR-01). Language buttons come with the Marathi and Hindi text (FR-41).
screens.welcome = () => render(page({
  showBack: false,
  cls: 'welcome',
  body: `<div class="hero">${dogTag('PUN-0001', 'hero-tag')}</div>
         <h1>${t('welcome_title')}</h1><p class="lead">${t('welcome_lead')}</p>`,
  actions: button('start', t('start')) + button('map', t('see_map'), 'secondary') +
    button('restore', t('have_code'), 'ghost'),
}), {
  start: () => { afterConsent = 'nickname'; go(store.get(KEY.consent) ? 'nickname' : 'consent'); },
  restore: () => { afterConsent = 'restore'; go(store.get(KEY.consent) ? 'restore' : 'consent'); },
  map: () => go('map'),
});

// Consent and safety (FR-03, NFR-10).
screens.consent = () => render(page({
  title: t('consent_title'),
  body: `<ul class="points">
      <li>${t('consent_1')}</li><li>${t('consent_2')}</li><li>${t('consent_3')}</li>
    </ul>
    <p class="safety">${t('consent_safety')}</p>`,
  actions: button('agree', t('agree')),
}), {
  agree: () => { store.set(KEY.consent, new Date().toISOString()); go(afterConsent, { replace: true }); },
});

// Nickname (FR-02).
screens.nickname = () => {
  render(page({
    title: t('nick_title'),
    lead: t('nick_lead'),
    body: `<label class="field"><span>${t('nick_label')}</span>
        <input id="nick" type="text" maxlength="20" autocomplete="nickname" autocapitalize="words"
               enterkeyhint="next" placeholder="${t('nick_placeholder')}"></label>
      <p class="hint">${t('mic_hint')}</p>
      <p class="error" id="nick-error" role="alert" hidden></p>`,
    actions: button('save', t('next')),
  }), { save: saveNickname });
  const input = app.querySelector('#nick');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNickname(); });
};

async function saveNickname() {
  const input = app.querySelector('#nick');
  const errEl = app.querySelector('#nick-error');
  const name = input.value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 20) {
    errEl.textContent = t('nick_error');
    errEl.hidden = false;
    return;
  }
  const btn = app.querySelector('[data-act="save"]');
  btn.disabled = true;
  btn.textContent = t('saving');
  try {
    await api.ensureSession();
    profile = await api.rpc('register_contributor', { p_nickname: name });
    go('code', { reset: true });
  } catch (e) {
    showError(e, () => go('nickname', { replace: true }));
  }
}

// Contributor code (FR-42).
screens.code = () => render(page({
  showBack: false,
  title: t('code_title'),
  lead: t('code_lead'),
  body: codeCard(),
  actions: button('saved', t('code_saved')),
}), {
  saved: () => startSighting('new', null, true),
  copy: copyCode,
});

function codeCard() {
  return `<div class="codecard"><span class="codecard-code">${esc(profile && profile.code)}</span>
    ${button('copy', t('copy'), 'small')}</div>`;
}

async function copyCode(el) {
  try {
    await navigator.clipboard.writeText(profile.code);
    el.textContent = t('copied');
  } catch (_) { /* clipboard not allowed; the code is on screen */ }
}

// Restore with a code (FR-43).
screens.restore = () => {
  render(page({
    title: t('restore_title'),
    lead: t('restore_lead'),
    body: `<label class="field"><span>${t('restore_label')}</span>
        <input id="code" type="text" maxlength="20" autocomplete="off" autocapitalize="characters"
               spellcheck="false" enterkeyhint="done" placeholder="RIYA-7KQ2XM"></label>
      <p class="error" id="code-error" role="alert" hidden></p>`,
    actions: button('claim', t('restore')),
  }), { claim: claimCode });
  app.querySelector('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') claimCode(); });
};

async function claimCode() {
  const input = app.querySelector('#code');
  const errEl = app.querySelector('#code-error');
  const code = input.value.trim();
  if (code.length < 6) { errEl.textContent = t('restore_notfound'); errEl.hidden = false; return; }
  const btn = app.querySelector('[data-act="claim"]');
  btn.disabled = true;
  try {
    await api.ensureSession();
    const res = await api.rpc('claim_code', { p_code: code });
    if (res && res.error) {
      errEl.textContent = t('restore_notfound');
      errEl.hidden = false;
      btn.disabled = false;
      return;
    }
    profile = res;
    go('home', { reset: true });
  } catch (e) {
    if (e.code === 'too_many_attempts') {
      errEl.textContent = t('err_too_many');
      errEl.hidden = false;
      btn.disabled = false;
    } else {
      showError(e, () => go('restore', { replace: true }));
    }
  }
}

// Home for returning contributors (FR-45).
screens.home = () => {
  if (!profile) return screens.welcome();
  const p = profile;
  const approved = p.approved_count || 0;
  const waiting = Math.max(0, (p.total_count || 0) - approved);
  const lines = [];
  if (approved) lines.push(`<p class="stat-main">${t(approved === 1 ? 'home_stats_one' : 'home_stats', { approved })}</p>`);
  if (waiting) lines.push(`<p class="${approved ? 'stat-sub' : 'stat-main'}">${t('home_waiting', { n: waiting })}</p>`);
  lines.push(`<p class="stat-sub">${p.rank ? t('home_rank', { rank: p.rank }) : t('home_first')}</p>`);
  const stats = `<div class="stats">${lines.join('')}</div>`;
  render(page({
    showBack: false,
    title: t('home_title', { name: esc(p.nickname || '') }),
    body: stats + (p.blocked ? `<p class="error">${t('home_blocked')}</p>` : ''),
    actions: (p.blocked ? '' : button('photo', t('photograph'))) + button('map', t('see_map'), 'secondary') +
      button('mine', t('my_contrib'), 'ghost'),
  }), {
    photo: () => startSighting('new'),
    map: () => go('map'),
    mine: () => go('mine'),
  });
  refreshProfile();
};

async function refreshProfile() {
  try {
    const fresh = await api.rpc('my_profile');
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(profile)) {
      profile = fresh;
      if (stack[stack.length - 1] === 'home') screens.home();
    }
  } catch (_) { /* keep what we have */ }
}

function goHome() {
  draft = null;
  go(profile ? 'home' : 'welcome', { reset: true });
}

// ---------------------------------------------------------------------
// Making a sighting
// ---------------------------------------------------------------------

function startSighting(mode, dog = null, fromCode = false) {
  draft = {
    id: uuid(),
    mode,                                   // 'new' or 'add_more'
    choice: mode === 'add_more' ? 'add_more' : null,
    dog,
    photos: [],
    pending: null,
    livePromise: null,
    loc: null,
    checks: {},
    newDog: {},
    startedAt: new Date().toISOString(),
  };
  const next = store.get(KEY.locAsked) ? 'capture' : 'location';
  if (fromCode) go(next, { home: true });
  else if (stack[stack.length - 1] === 'home') go(next);
  else go(next, { home: true });
}

function startLive() {
  if (draft && !draft.livePromise) draft.livePromise = getLiveLocation();
}

// Location permission, first time only (FR-12).
screens.location = () => render(page({
  title: t('loc_title'),
  lead: t('loc_lead'),
  body: '<div class="pin-art" aria-hidden="true"></div>',
  actions: button('allow', t('loc_allow')),
}), {
  allow: () => {
    store.set(KEY.locAsked, '1');
    startLive();
    go('capture', { replace: true });
  },
});

// Camera first, gallery as fallback (FR-05, FR-06).
screens.capture = () => {
  if (!draft) return goHome();
  render(page({
    step: 1,
    title: t('cap_title'),
    lead: t('cap_lead'),
    body: `<div class="camera-art" aria-hidden="true"></div><p class="safety small">${t('consent_safety')}</p>`,
    actions: button('camera', t('take_photo')) + button('gallery', t('from_gallery'), 'ghost'),
  }), {
    camera: openCamera,
    gallery: openGallery,
  });
};

function openCamera() { startLive(); camInput.click(); }
function openGallery() { galInput.click(); }

camInput.addEventListener('change', () => takeFile(camInput, 'camera'));
galInput.addEventListener('change', () => takeFile(galInput, 'gallery'));

async function takeFile(input, source) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !draft) return;
  go('processing');
  try {
    const prepared = await prepPhoto(file);
    draft.pending = { ...prepared, source, id: uuid() };
    go('angle', { replace: true });
  } catch (_) {
    go('photoerror', { replace: true });
  }
}

screens.processing = () => busy(t('preparing'));

screens.photoerror = () => render(page({
  title: t('err_title'),
  lead: t('photo_error'),
  actions: button('camera', t('take_photo')) + button('gallery', t('from_gallery'), 'ghost'),
}), { camera: openCamera, gallery: openGallery });

// Photo check: tapping the view both accepts the photo and tags it (FR-08, FR-10).
screens.angle = () => {
  const p = draft && draft.pending;
  if (!p) return draft && draft.photos.length ? go('more', { replace: true }) : goHome();
  const used = new Set(draft.photos.map((x) => x.angle));
  const warn = p.quality ? `<p class="warn" role="status">${t(p.quality === 'dark' ? 'warn_dark' : 'warn_blurry')}</p>` : '';
  render(page({
    step: 1,
    title: t('angle_title'),
    body: `<figure class="preview"><img src="${p.url}" alt="">${button('retake', t('retake'), 'small retake')}</figure>${warn}
      <p class="lead">${t('angle_lead')}</p>
      ${choices('angle', ANGLES.map((a) => ({
        value: a, label: t(`angle_${a}`), sub: used.has(a) && a !== 'other' ? t('added') : '', done: used.has(a) && a !== 'other',
      })))}`,
  }), {
    angle: (el) => {
      draft.photos.push({ ...draft.pending, angle: el.dataset.value });
      draft.pending = null;
      if (draft.photos.length >= 5) afterPhotos();
      else go('more', { replace: true });
    },
    retake: () => {
      const source = draft.pending.source;
      URL.revokeObjectURL(draft.pending.url);
      draft.pending = null;
      stack.pop();
      history.replaceState({ md: stack.length }, '');
      if (source === 'camera') openCamera(); else openGallery();
      show(stack[stack.length - 1]);
    },
  });
};

// More views? Never required (FR-07).
screens.more = () => {
  if (!draft || !draft.photos.length) return goHome();
  const used = new Set(draft.photos.map((x) => x.angle));
  const left = SUGGESTED.filter((a) => !used.has(a)).map((a) => t(`angle_${a}`).toLowerCase());
  const full = draft.photos.length >= 5;
  render(page({
    step: 1,
    title: t('more_title'),
    lead: t('more_lead'),
    body: `<div class="thumbs">${draft.photos.map((p) => `<img src="${p.url}" alt="${esc(t(`angle_${p.angle}`))}">`).join('')}</div>
      <p class="count">${t('more_count', { n: draft.photos.length })}</p>
      ${left.length && !full ? `<p class="hint">${t('more_try', { list: left.join(', ') })}</p>` : ''}`,
    actions: full
      ? button('done', t('done_photos'))
      : button('add', t('add_photo')) + button('done', t('done_photos'), 'secondary') +
        button('gallery', t('from_gallery'), 'ghost'),
  }), {
    add: openCamera,
    gallery: openGallery,
    done: afterPhotos,
  });
};

// Where was the dog? (FR-13, FR-14)
async function afterPhotos() {
  const first = draft.photos[0];
  const withGps = draft.photos.find((p) => p.exif.lat != null);
  draft.nearby = null;   // location may have changed: look again
  draft.capturedAt = (first.source === 'gallery' && first.exif.time) || draft.startedAt;

  if (first.source === 'camera') {
    if (!draft.livePromise) startLive();
    go('locating');
    const live = await draft.livePromise;
    if (live) {
      draft.loc = { lat: live.lat, lng: live.lng, accuracy: live.accuracy, source: 'live' };
      return afterLocation(true);
    }
  }
  if (withGps) {
    draft.loc = { lat: withGps.exif.lat, lng: withGps.exif.lng, accuracy: null, source: 'exif' };
    return afterLocation(first.source === 'camera');
  }
  if (first.source === 'camera') go('pin', { replace: true });
  else go('pin');
}

function afterLocation(replaceCurrent) {
  store.set(KEY.lastLoc, JSON.stringify({ lat: draft.loc.lat, lng: draft.loc.lng }));
  const next = draft.mode === 'add_more' ? null : 'which';
  if (!next) return sendSighting();
  go(next, { replace: !!replaceCurrent });
}

screens.locating = () => busy(t('locating'));

// Drop a pin when there is no location (FR-13).
screens.pin = () => {
  render(page({
    step: 1,
    title: t('pin_title'),
    lead: t('pin_lead'),
    body: `<div class="pinmap"><div id="map" class="map">${t('pin_loading')}</div><span class="pin-center" aria-hidden="true"></span></div>`,
    actions: button('confirm', t('pin_confirm'), 'primary', 'disabled'),
  }), {
    confirm: () => {
      const c = mapInstance.getCenter();
      draft.loc = { lat: c.lat, lng: c.lng, accuracy: null, source: 'manual' };
      afterLocation(true);
    },
  });
  let start = PUNE;
  let zoom = 13;
  try {
    const last = JSON.parse(store.get(KEY.lastLoc) || 'null');
    if (last && Number.isFinite(last.lat)) { start = last; zoom = 17; }
  } catch (_) { /* ignore */ }
  loadLeaflet().then((L) => {
    const el = app.querySelector('#map');
    if (!el) return;
    el.textContent = '';
    mapInstance = L.map(el, { zoomControl: true, attributionControl: true }).setView([start.lat, start.lng], zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapInstance);
    app.querySelector('[data-act="confirm"]').disabled = false;
  }).catch((e) => showError({ code: 'network' }, () => screens.pin()));
};

// "Is it one of these?" (FR-17, FR-18)
screens.which = async () => {
  if (!draft || !draft.loc) return goHome();
  const actions = button('newdog', t('new_dog')) + button('unsure', t('not_sure'), 'secondary');
  const h = {
    newdog: () => { draft.choice = 'new'; draft.dog = null; go('ear'); },
    unsure: () => { draft.choice = 'unsure'; draft.dog = null; go('ear'); },
    pick: (el) => {
      draft.candidate = draft.nearby.find((d) => String(d.dog_id) === el.dataset.value);
      go('compare');
    },
  };
  const paint = (inner) => render(page({ step: 2, title: t('which_title'), lead: t('which_lead'), body: inner, actions }), h);

  if (!draft.nearby) {
    paint(`<div class="busy inline"><span class="spinner" aria-hidden="true"></span><p>${t('which_loading')}</p></div>`);
    try {
      draft.nearby = await api.rpc('nearby_dogs', { p_lat: draft.loc.lat, p_lng: draft.loc.lng, p_radius_m: 500 }) || [];
      draft.urls = await api.photoUrls(draft.nearby.map((d) => d.thumb_path));
    } catch (_) {
      draft.nearby = null;
      if (stack[stack.length - 1] === 'which') paint(`<p class="warn">${t('which_error')}</p>`);
      return;
    }
    if (stack[stack.length - 1] !== 'which') return;
  }

  if (!draft.nearby.length) return paint(`<p class="empty">${t('which_empty')}</p>`);
  paint(`<div class="dogs">${draft.nearby.map((d) => {
    const url = draft.urls[d.thumb_path];
    return `<button type="button" class="dogcard" data-act="pick" data-value="${d.dog_id}">
        <span class="dogcard-img">${url ? `<img src="${url}" alt="" loading="lazy">` : ''}</span>
        <span class="dogcard-text">
          <span class="dogcard-name">${esc(d.name || d.code)}</span>
          ${d.name ? `<span class="dogcard-meta">${esc(d.code)}</span>` : ''}
          <span class="dogcard-meta">${d.is_pending ? `<span class="chip review">${t('under_review')}</span>` : t('seen', { when: ago(d.last_seen_at) })}</span>
          <span class="dogcard-meta">${t('metres_away', { m: d.distance_m })}</span>
        </span>
      </button>`;
  }).join('')}</div>`);
};

// Compare before confirming (FR-46).
screens.compare = async () => {
  const d = draft && draft.candidate;
  if (!d) return goHome();
  const label = esc(d.name || d.code);
  const h = {
    yes: () => { draft.choice = 'known'; draft.dog = { id: d.dog_id, code: d.code, name: d.name }; go('ear'); },
    no: back,
  };
  const paint = (theirs) => render(page({
    step: 2,
    title: label,
    lead: `${esc(d.code)} · ${t('compare_lead')}`,
    body: `<p class="label">${t('your_photo')}</p>
      <div class="thumbs"><img src="${draft.photos[0].url}" alt=""></div>
      <p class="label">${t('their_photos', { name: label })}</p>
      <div class="strip">${theirs}</div>`,
    actions: button('yes', t('yes_same', { name: label })) + button('no', t('no_back'), 'secondary'),
  }), h);
  paint('<span class="spinner" aria-hidden="true"></span>');
  try {
    const rows = await api.rpc('dog_photos', { p_dog_id: d.dog_id }) || [];
    const urls = await api.photoUrls(rows.map((r) => r.storage_path));
    if (stack[stack.length - 1] !== 'compare') return;
    paint(rows.map((r) => (urls[r.storage_path] ? `<img src="${urls[r.storage_path]}" alt="${esc(t(`angle_${r.angle}`))}" loading="lazy">` : '')).join(''));
  } catch (_) {
    if (stack[stack.length - 1] === 'compare') paint(`<p class="warn">${t('err_network')}</p>`);
  }
};

// Quick checks, one per screen (FR-21, FR-47).
function checkScreen(key, title, lead, next) {
  return () => {
    if (!draft) return goHome();
    render(page({
      step: 3,
      title: t(title),
      lead: lead ? t(lead) : '',
      body: choices('pick', [
        { value: 'yes', label: t('yes') },
        { value: 'no', label: t('no') },
        { value: 'unsure', label: t('cant_see') },
      ]),
    }), {
      pick: (el) => { draft.checks[key] = el.dataset.value; next(); },
    });
  };
}

screens.ear = checkScreen('ear_notch', 'ear_title', 'ear_lead', () => go('collar'));
screens.collar = checkScreen('collar', 'collar_title', '', () => go('injured'));
screens.injured = checkScreen('injured', 'injured_title', '', () => {
  if (draft.choice === 'new') go('dname');
  else sendSighting();
});

// Optional details for a new dog, each skippable (FR-20, FR-22, NFR-22).
function textScreen(field, title, label, placeholder, maxlength, next, multiline = false) {
  return () => {
    if (!draft) return goHome();
    const value = esc(draft.newDog[field] || '');
    const input = multiline
      ? `<textarea id="f" maxlength="${maxlength}" rows="3" placeholder="${t(placeholder)}">${value}</textarea>`
      : `<input id="f" type="text" maxlength="${maxlength}" autocapitalize="words" enterkeyhint="next" placeholder="${t(placeholder)}" value="${value}">`;
    render(page({
      step: 4,
      title: t(title),
      body: `<label class="field"><span>${t(label)}</span>${input}</label><p class="hint">${t('mic_hint')}</p>`,
      actions: button('next', t('next')) + button('skip', t('skip_rest'), 'ghost'),
    }), {
      next: () => { draft.newDog[field] = app.querySelector('#f').value.trim(); next(); },
      // Keep anything already typed, even when skipping the rest.
      skip: () => { draft.newDog[field] = app.querySelector('#f').value.trim(); sendSighting(); },
    });
  };
}

function pickScreen(field, title, options, next) {
  return () => {
    if (!draft) return goHome();
    render(page({
      step: 4,
      title: t(title),
      body: choices('pick', options.map((o) => ({ value: o, label: t(o) }))),
      actions: button('skip', t('skip_rest'), 'ghost'),
    }), {
      pick: (el) => { draft.newDog[field] = el.dataset.value; next(); },
      skip: sendSighting,
    });
  };
}

screens.dname = textScreen('name', 'name_title', 'name_label', 'name_placeholder', 40, () => go('sex'));
screens.sex = pickScreen('sex', 'sex_title', ['male', 'female', 'unknown'], () => go('age'));
screens.age = pickScreen('age_group', 'age_title', ['puppy', 'adult', 'senior', 'unknown'], () => go('notes'));
screens.notes = textScreen('notes', 'notes_title', 'notes_label', 'notes_placeholder', 280, sendSighting, true);

// Upload the photos, then save the sighting.
screens.uploading = () => busy(t('uploading'));

async function sendSighting() {
  const d = draft;
  if (!d) return goHome();
  go('uploading');
  const status = () => app.querySelector('.busy p');
  try {
    const session = await api.ensureSession();
    const uid = session.user.id;
    for (let i = 0; i < d.photos.length; i++) {
      const p = d.photos[i];
      p.path = `${uid}/${d.id}/${p.id}.jpg`;
      if (!p.uploaded) {
        if (status()) status().textContent = `${t('uploading')} ${t('uploading_photo', { i: i + 1, n: d.photos.length })}`;
        await api.uploadPhoto(p.path, p.blob);
        p.uploaded = true;
      }
    }
    if (status()) status().textContent = t('saving');
    const age = d.newDog.age_group === 'unknown' ? null : d.newDog.age_group;
    d.result = await api.rpc('submit_sighting', {
      p: {
        id: d.id,
        choice: d.choice,
        dog_id: d.dog ? d.dog.id : null,
        lat: d.loc.lat,
        lng: d.loc.lng,
        accuracy_m: d.loc.accuracy,
        location_source: d.loc.source,
        captured_at: d.capturedAt,
        ear_notch: d.checks.ear_notch || null,
        collar: d.checks.collar || null,
        injured: d.checks.injured || null,
        new_dog: d.choice === 'new' ? {
          name: d.newDog.name || null,
          sex: d.newDog.sex || null,
          age_group: age || null,
          notes: d.newDog.notes || null,
        } : null,
        photos: d.photos.map((p) => ({
          id: p.id,
          path: p.path,
          angle: p.angle,
          source: p.source,
          width: p.width,
          height: p.height,
          bytes: p.bytes,
          exif_lat: p.exif.lat,
          exif_lng: p.exif.lng,
          exif_time: p.exif.time,
          quality_warning: p.quality || null,
        })),
      },
    });
    go('thanks', { home: true });
  } catch (e) {
    showError(e, () => { stack.pop(); sendSighting(); });
  }
}

// Thank you (FR-23).
screens.thanks = () => {
  const d = draft;
  if (!d || !d.result) return goHome();
  const r = d.result;
  const name = esc(r.dog_name || r.dog_code || '');
  let body;
  if (d.choice === 'new') {
    body = `<p class="lead">${t('thanks_new')}</p>${dogTag(r.dog_code, 'stamp')}
      ${r.dog_name ? `<p class="dogname">${esc(r.dog_name)}</p>` : ''}`;
  } else if (d.choice === 'known') {
    body = `${dogTag(r.dog_code, 'stamp')}<p class="lead">${t('thanks_known', { name, n: r.dog_photo_count })}</p>`;
  } else if (d.choice === 'add_more') {
    body = `${dogTag(r.dog_code, 'stamp')}<p class="lead">${t('thanks_more', { name })}</p>`;
  } else {
    body = `<p class="lead">${t('thanks_unsure')}</p>`;
  }
  body += `<p class="hint">${t('thanks_review')}</p>`;
  const dog = r.dog_id ? { id: r.dog_id, code: r.dog_code, name: r.dog_name } : null;
  render(page({
    title: t('thanks_title'),
    body,
    actions: (dog ? button('more', t('add_more')) : '') +
      button('another', t('another'), dog ? 'secondary' : 'primary') +
      button('map', t('see_map'), 'ghost'),
  }), {
    more: () => startSighting('add_more', dog),
    another: () => startSighting('new'),
    map: () => go('map'),
  });
  refreshProfile();
};

// My contributions (FR-29).
screens.mine = async () => {
  const statusLabel = (s) => ({
    screening: ['st_waiting', 'review'], review: ['st_waiting', 'review'], approved: ['st_approved', 'ok'],
    rejected: ['st_rejected', 'no'], deleted: ['st_deleted', 'no'],
  }[s] || ['st_waiting', 'review']);
  const paint = (list) => render(page({
    title: t('mine_title'),
    body: `<p class="label">${t('mine_code')}</p>${codeCard()}${list}`,
  }), { copy: copyCode });
  paint('<div class="busy inline"><span class="spinner" aria-hidden="true"></span></div>');
  try {
    const rows = await api.rpc('my_submissions', { p_limit: 100 }) || [];
    const urls = await api.photoUrls(rows.map((r) => r.thumb_path));
    if (stack[stack.length - 1] !== 'mine') return;
    if (!rows.length) return paint(`<p class="empty">${t('mine_empty')}</p>`);
    paint(`<ul class="subs">${rows.map((r) => {
      const [key, tone] = statusLabel(r.status);
      const url = urls[r.thumb_path];
      return `<li class="sub">
          <span class="sub-img">${url ? `<img src="${url}" alt="" loading="lazy">` : ''}</span>
          <span class="sub-text">
            <span class="sub-dog">${r.dog_code ? esc(r.dog_name ? `${r.dog_name} (${r.dog_code})` : r.dog_code) : t('unsure_dog')}</span>
            <span class="sub-meta">${ago(r.created_at)} · ${r.photo_count === 1 ? t('photos_1') : t('photos_n', { n: r.photo_count })}</span>
            <span class="chip ${tone}">${t(key)}</span>
            ${r.reject_reason ? `<span class="sub-meta">${esc(r.reject_reason)}</span>` : ''}
          </span>
        </li>`;
    }).join('')}</ul>`);
  } catch (e) {
    if (stack[stack.length - 1] === 'mine') paint(`<p class="warn">${errorText(e)}</p>`);
  }
};

// ---------------------------------------------------------------------
// Public map (FR-24 to FR-27, FR-48, FR-49) and leaderboard (FR-28)
// ---------------------------------------------------------------------

const mapState = { notch: 'all', days: 0, data: null };

const FILTERS_NOTCH = [['all', 'filter_all'], ['yes', 'filter_notched'], ['no', 'filter_not_notched']];
const FILTERS_DAYS = [0, 7, 30, 90];

function chip(act, value, label, on) {
  return `<button type="button" class="fchip${on ? ' on' : ''}" data-act="${act}" data-value="${value}" aria-pressed="${on}">${label}</button>`;
}

function totalsText(s) {
  const part = (n, key) => (n === 1 ? t(`${key}_1`) : t(`${key}_n`, { n }));
  return [part(s.dogs || 0, 'dogs'), part(s.photos || 0, 'photos'), part(s.contributors || 0, 'contributors')].join(', ');
}

async function loadMapData() {
  const [dogs, pending, stats] = await Promise.all([
    api.rpc('map_dogs'), api.rpc('map_pending'), api.rpc('map_stats'),
  ]);
  mapState.data = { dogs: dogs || [], pending: pending || [], stats: stats || {} };
}

// Dogs in the same ~100 m square share one marker with a count.
function groupItems() {
  const { dogs, pending } = mapState.data;
  const cutoff = mapState.days ? Date.now() - mapState.days * 86400000 : 0;
  const shownDogs = dogs.filter((d) =>
    (mapState.notch === 'all' || d.ear_notch === mapState.notch) &&
    (!cutoff || new Date(d.last_seen_at).getTime() >= cutoff));
  const groups = new Map();
  // Everything, including your own exact sightings, is grouped by the same
  // ~100 m square, so your sighting never hides under a dog's marker.
  const add = (rawLat, rawLng, item) => {
    const lat = Math.round(rawLat * 1000) / 1000;
    const lng = Math.round(rawLng * 1000) / 1000;
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, { lat, lng, items: [] });
    groups.get(key).items.push(item);
  };
  shownDogs.forEach((d) => add(d.lat, d.lng, { kind: 'dog', ...d }));
  pending.forEach((p) => add(p.lat, p.lng, { kind: p.is_mine ? 'mine' : 'pending', ...p }));
  return [...groups.values()];
}

screens.map = () => {
  const s = mapState.data && mapState.data.stats;
  render(`<main class="mapscreen">
      <header class="maphead">
        <div class="maphead-row">
          ${stack.length > 1 ? `<button class="back" data-act="back" type="button">‹ ${t('back')}</button>` : ''}
          <button type="button" class="btn small" data-act="leaders">${t('leaderboard')}</button>
        </div>
        <h1>${t('map_title')}</h1>
        <p class="maptotals">${s ? totalsText(s) : '&nbsp;'}</p>
        <div class="filters" role="group">
          ${FILTERS_NOTCH.map(([v, k]) => chip('notch', v, t(k), mapState.notch === v)).join('')}
          ${FILTERS_DAYS.map((n) => chip('days', n, n ? t('filter_days', { n }) : t('filter_any'), mapState.days === n)).join('')}
        </div>
        <ul class="legend">
          <li><span class="dot dog"></span>${t('legend_dog')}</li>
          <li><span class="dot mine"></span>${t('legend_mine')}</li>
          <li><span class="dot pending"></span>${t('legend_pending')}</li>
        </ul>
      </header>
      <div class="mapwrap">
        <div id="bigmap" class="bigmap">${t('map_loading')}</div>
        <button type="button" class="btn small nearme" data-act="near">${t('near_me')}</button>
        <aside class="sheet" id="sheet" hidden></aside>
      </div>
    </main>`, {
    leaders: () => go('leaders'),
    notch: (el) => { mapState.notch = el.dataset.value; screens.map(); },
    days: (el) => { mapState.days = Number(el.dataset.value); screens.map(); },
    near: nearMe,
    closesheet: closeSheet,
  });
  drawMap();
};

let markerLayer = null;
let meMarker = null;

async function drawMap() {
  const keepView = mapInstance ? { center: mapInstance.getCenter(), zoom: mapInstance.getZoom() } : null;
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  let L;
  try {
    [L] = await Promise.all([loadLeaflet(), mapState.data ? null : loadMapData()]);
  } catch (e) {
    const el = app.querySelector('#bigmap');
    if (el) el.innerHTML = `<p class="warn">${t('map_error')}</p>`;
    return;
  }
  const el = app.querySelector('#bigmap');
  if (!el || stack[stack.length - 1] !== 'map') return;
  if (!app.querySelector('.maptotals').textContent.trim()) {
    app.querySelector('.maptotals').textContent = totalsText(mapState.data.stats);
  }
  el.textContent = '';
  mapInstance = L.map(el, { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapInstance);
  markerLayer = L.layerGroup().addTo(mapInstance);
  mapInstance.on('click', closeSheet);

  const groups = groupItems();
  for (const g of groups) {
    const hasDog = g.items.some((i) => i.kind === 'dog');
    const hasMine = g.items.some((i) => i.kind === 'mine');
    const kind = hasDog ? 'dog' : hasMine ? 'mine' : 'pending';
    const size = kind === 'pending' ? 22 : 30;
    // Count dogs, not sightings: your own sighting of a dog already shown here adds no number.
    const shownCodes = new Set(g.items.filter((i) => i.kind === 'dog').map((i) => i.code));
    const distinct = g.items.filter((i) => !(i.kind === 'mine' && i.dog_code && shownCodes.has(i.dog_code))).length;
    const count = distinct > 1 ? distinct : '';
    const icon = L.divIcon({
      className: 'mk-wrap',
      html: `<span class="mk mk-${kind}${hasDog && hasMine ? ' mk-ring' : ''}">${count}</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    L.marker([g.lat, g.lng], { icon, keyboard: true, title: t(`legend_${kind}`) })
      .addTo(markerLayer)
      .on('click', (e) => { if (e.originalEvent) e.originalEvent.stopPropagation(); openSheet(g); });
  }

  if (keepView) {
    mapInstance.setView(keepView.center, keepView.zoom);
  } else if (groups.length) {
    mapInstance.fitBounds(L.latLngBounds(groups.map((g) => [g.lat, g.lng])), { padding: [40, 40], maxZoom: 16 });
  } else {
    let start = PUNE;
    let zoom = 12;
    try {
      const last = JSON.parse(store.get(KEY.lastLoc) || 'null');
      if (last && Number.isFinite(last.lat)) { start = last; zoom = 15; }
    } catch (_) { /* ignore */ }
    mapInstance.setView([start.lat, start.lng], zoom);
  }
  if (!mapState.data.dogs.length && !mapState.data.pending.length) {
    showSheet(`<p class="empty">${t('map_empty')}</p>`);
  }
}

function showSheet(inner) {
  const sheet = app.querySelector('#sheet');
  if (!sheet) return;
  sheet.innerHTML = `<button type="button" class="sheet-close" data-act="closesheet" aria-label="${t('close')}">×</button>${inner}`;
  sheet.hidden = false;
}

function closeSheet() {
  const sheet = app.querySelector('#sheet');
  if (sheet) sheet.hidden = true;
}

async function openSheet(group) {
  const order = { dog: 0, mine: 1, pending: 2 };
  const items = [...group.items].sort((a, b) => order[a.kind] - order[b.kind]);
  const paint = (urls) => showSheet(`<ul class="sheet-list">${items.map((i) => {
    if (i.kind === 'dog') {
      const ear = i.ear_notch === 'yes' ? t('ear_yes') : i.ear_notch === 'no' ? t('ear_no') : t('ear_unknown');
      return `<li class="sheet-item">
          <span class="sub-img">${urls[i.thumb_path] ? `<img src="${urls[i.thumb_path]}" alt="">` : ''}</span>
          <span class="sub-text">
            <span class="dogcard-name">${esc(i.name || i.code)}</span>
            ${i.name ? `<span class="sub-meta">${esc(i.code)}</span>` : ''}
            <span class="sub-meta">${ear}</span>
            <span class="sub-meta">${t('last_seen', { when: ago(i.last_seen_at) })} · ${i.photo_count === 1 ? t('photos_1') : t('photos_n', { n: i.photo_count })}</span>
          </span>
        </li>`;
    }
    if (i.kind === 'mine') {
      return `<li class="sheet-item">
          <span class="sub-img">${urls[i.thumb_path] ? `<img src="${urls[i.thumb_path]}" alt="">` : ''}</span>
          <span class="sub-text">
            <span class="sub-dog">${i.dog_code ? esc(i.dog_name ? `${i.dog_name} (${i.dog_code})` : i.dog_code) : t('not_identified')}</span>
            <span class="chip review">${t('under_review')}</span>
            <span class="sub-meta">${t('sent', { when: ago(i.created_at) })}</span>
          </span>
        </li>`;
    }
    return `<li class="sheet-item">
        <span class="sub-img pending-img" aria-hidden="true"></span>
        <span class="sub-text">
          <span class="sub-dog">${t('pending_other')}</span>
          <span class="sub-meta">${t('sent', { when: ago(i.created_at) })}</span>
        </span>
      </li>`;
  }).join('')}</ul>`);
  paint({});
  try {
    const urls = await api.photoUrls(items.map((i) => i.thumb_path).filter(Boolean));
    if (stack[stack.length - 1] === 'map' && !app.querySelector('#sheet').hidden) paint(urls);
  } catch (_) { /* photos stay blank */ }
}

async function nearMe(el) {
  el.disabled = true;
  const here = await getLiveLocation(8000);
  el.disabled = false;
  if (!here || !mapInstance) return;
  const L = window.L;
  if (meMarker) meMarker.remove();
  meMarker = L.circleMarker([here.lat, here.lng], {
    radius: 8, color: '#ffffff', weight: 3, fillColor: '#2563eb', fillOpacity: 1,
  }).addTo(mapInstance);
  mapInstance.setView([here.lat, here.lng], 16);
}

screens.leaders = async () => {
  const s = mapState.data && mapState.data.stats;
  const paint = (inner) => render(page({
    title: t('lb_title'),
    lead: t('lb_lead'),
    body: (s ? `<p class="hint">${totalsText(s)}</p>` : '') + inner,
  }));
  paint('<div class="busy inline"><span class="spinner" aria-hidden="true"></span></div>');
  try {
    const rows = await api.rpc('leaderboard', { p_limit: 50 }) || [];
    if (stack[stack.length - 1] !== 'leaders') return;
    if (!rows.length) return paint(`<p class="empty">${t('lb_empty')}</p>`);
    paint(`<ol class="board">${rows.map((r) => `<li class="board-row${r.is_me ? ' me' : ''}">
        <span class="board-rank">${r.rank}</span>
        <span class="board-name">${esc(r.nickname)} <span class="board-tag">#${esc(r.tag)}</span>${r.is_me ? ` <span class="chip ok">${t('lb_you')}</span>` : ''}</span>
        <span class="board-count">${r.approved_count === 1 ? t('lb_count_one') : t('lb_count', { n: r.approved_count })}</span>
      </li>`).join('')}</ol>`);
  } catch (e) {
    if (stack[stack.length - 1] === 'leaders') paint(`<p class="warn">${errorText(e)}</p>`);
  }
};

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

async function init() {
  setLanguage(store.get(KEY.lang) || 'en');
  if (!api.configured) { stack.push('setup'); return screens.setup(); }
  history.replaceState({ md: 1 }, '');
  busy('');
  let session = null;
  try {
    session = await api.getSession();
    if (session) profile = await api.rpc('my_profile');
  } catch (e) {
    if (session) {
      stack.push('home');
      return showError(e, () => location.reload());
    }
  }
  // A shared link ending in #map opens the map straight away.
  const wantsMap = location.hash === '#map';
  if (wantsMap) history.replaceState({ md: 1 }, '', location.pathname + location.search);
  if (profile) stack.push('home');
  else if (session && store.get(KEY.consent)) stack.push('nickname');
  else stack.push('welcome');
  if (wantsMap) return go('map');
  show(stack[0]);
}

init();
