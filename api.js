// Talking to Supabase: login, database functions and photo storage.
const cfg = window.MAPDOGS_CONFIG || {};

export const configured =
  typeof cfg.supabaseUrl === 'string' && cfg.supabaseUrl.startsWith('https://') &&
  !cfg.supabaseUrl.includes('PASTE') &&
  typeof cfg.supabaseKey === 'string' && cfg.supabaseKey.length > 20 &&
  !cfg.supabaseKey.includes('PASTE') &&
  !!window.supabase;

export const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;

const BUCKET = 'photos';

// Turns any failure into an Error whose .code the screens understand.
function appError(raw) {
  const msg = (raw && (raw.message || raw.error_description || raw.error)) || '';
  const err = new Error(msg || 'unknown');
  const known = ['rate_limited', 'blocked', 'too_many_attempts', 'not_registered', 'not_signed_in',
    'dog_not_found', 'bad_nickname', 'bad_photos', 'bad_photo_path'];
  err.code = known.find((k) => msg.includes(k)) ||
    (/fetch|network|Failed to|Load failed|timeout/i.test(msg) ? 'network' : 'generic');
  return err;
}

export async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session;
}

// Contributors log in "anonymously": no email or phone (NFR-12).
export async function ensureSession() {
  const existing = await getSession();
  if (existing) return existing;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) {
    const e = appError(error);
    if (e.code === 'generic') e.code = 'signin';
    throw e;
  }
  return data.session;
}

export async function rpc(name, args = {}) {
  let result;
  try {
    result = await sb.rpc(name, args);
  } catch (e) {
    throw appError(e);
  }
  if (result.error) throw appError(result.error);
  return result.data;
}

export async function uploadPhoto(path, blob) {
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  });
  // Already there from an earlier attempt: that's fine.
  if (error && !/exists|Duplicate/i.test(error.message || '') && String(error.statusCode) !== '409') {
    throw appError(error);
  }
}

// Photos are private; viewing needs a short-lived signed link.
const urlCache = new Map();
export async function photoUrls(paths) {
  const wanted = [...new Set(paths.filter(Boolean))].filter((p) => !urlCache.has(p));
  if (wanted.length) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(wanted, 3600);
    if (!error && data) {
      for (const row of data) if (row.signedUrl) urlCache.set(row.path, row.signedUrl);
    }
  }
  const out = {};
  for (const p of paths) if (urlCache.has(p)) out[p] = urlCache.get(p);
  return out;
}
