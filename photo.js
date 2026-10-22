// Photo preparation, location and map helpers.

const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7/dist/lite.umd.js';
const LEAFLET_JS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';

const MAX_SIDE = 1280;         // pixels on the long side (about 200 KB per photo)
const TARGET_BYTES = 300000;   // re-compress harder above this

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(src); reject(new Error('network')); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}

export async function loadLeaflet() {
  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = LEAFLET_CSS;
    document.head.appendChild(l);
  }
  await loadScript(LEAFLET_JS);
  return window.L;
}

// GPS and time from the ORIGINAL photo, before resizing removes them.
async function readExif(file) {
  const out = { lat: null, lng: null, time: null };
  try {
    await loadScript(EXIFR_URL);
    const gps = await window.exifr.gps(file);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude) &&
        !(gps.latitude === 0 && gps.longitude === 0)) {
      out.lat = gps.latitude;
      out.lng = gps.longitude;
    }
    const tags = await window.exifr.parse(file, ['DateTimeOriginal']);
    const d = tags && tags.DateTimeOriginal;
    if (d instanceof Date && !Number.isNaN(d.getTime())) out.time = d.toISOString();
  } catch (_) {
    // No metadata is normal (many phones and apps strip it).
  }
  return out;
}

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) { /* fall back below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', quality);
  });
}

// Rough check for very dark or very blurry photos (FR-10).
function assess(source, w, h) {
  const sw = 200;
  const sh = Math.max(1, Math.round((h / w) * sw));
  const c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, sw, sh);
  const { data } = ctx.getImageData(0, 0, sw, sh);
  const gray = new Float32Array(sw * sh);
  let sum = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[j] = g;
    sum += g;
  }
  const mean = sum / gray.length;
  if (mean < 40) return 'dark';
  let n = 0, s1 = 0, s2 = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - sw] + gray[i + sw] - 4 * gray[i];
      s1 += lap;
      s2 += lap * lap;
      n++;
    }
  }
  const variance = n ? s2 / n - (s1 / n) ** 2 : 0;
  return variance < 25 ? 'blurry' : null;
}

export async function prepPhoto(file) {
  const exif = await readExif(file);
  const img = await decode(file);
  const w0 = img.width || img.naturalWidth;
  const h0 = img.height || img.naturalHeight;
  if (!w0 || !h0) throw new Error('decode');
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const width = Math.round(w0 * scale);
  const height = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  let blob = await toBlob(canvas, 0.8);
  if (blob.size > TARGET_BYTES) blob = await toBlob(canvas, 0.66);
  const quality = assess(canvas, width, height);
  if (img.close) img.close();
  return { blob, width, height, bytes: blob.size, exif, quality, url: URL.createObjectURL(blob) };
}

// Best live location within a few seconds (FR-12). Resolves null when
// the person says no or the phone can't tell.
export function getLiveLocation(maxWaitMs = 10000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    let best = null;
    let finished = false;
    let watchId = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearTimeout(timer);
      resolve(best);
    };
    const timer = setTimeout(finish, maxWaitMs);
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        if (!best || c.accuracy < best.accuracy) {
          best = { lat: c.latitude, lng: c.longitude, accuracy: Math.round(c.accuracy) };
        }
        if (c.accuracy <= 25) finish();
      },
      (err) => { if (err.code === err.PERMISSION_DENIED || !best) finish(); },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: maxWaitMs },
    );
  });
}
