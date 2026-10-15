'use strict';
/**
 * Geko shared utilities: date maths (all in UTC calendar days, no timezone drift),
 * UK postcode helpers, and postcode geocoding via postcodes.io.
 * Files in api/_lib are not exposed as routes by Vercel (underscore prefix).
 */

const MS_DAY = 86400000;

/* ── Dates ────────────────────────────────────────────────────────────────── */
function toISO(dt) { return dt.toISOString().slice(0, 10); }

// Accepts "DD/MM/YYYY" or "YYYY-MM-DD" (optionally followed by a time). Returns "YYYY-MM-DD" or null.
function parseJobDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let y, m, d, match;
  if ((match = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/))) {
    y = +match[1]; m = +match[2]; d = +match[3];
  } else if ((match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    d = +match[1]; m = +match[2]; y = +match[3];
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return toISO(dt);
}

function isISODate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseJobDate(s) === s; }
function addDays(iso, n) { return toISO(new Date(Date.parse(iso + 'T00:00:00Z') + n * MS_DAY)); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / MS_DAY); }
function isWeekend(iso) { const w = new Date(iso + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; }

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Today's calendar date in the UK (the business operates on UK dates).
function londonToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// Working days a job occupies: starts on `startIso`, skips weekends, `length` working days.
// Mirrors getSpannedDates() in booking.html so the API agrees with the booking page.
function spannedWorkingDates(startIso, length) {
  let n = parseInt(length, 10);
  if (isNaN(n) || n < 1) n = 1;
  if (n > 60) n = 60;
  const out = [];
  let cur = startIso;
  while (n > 0) {
    if (!isWeekend(cur)) { out.push(cur); n--; }
    cur = addDays(cur, 1);
  }
  return out;
}

/* ── Postcodes ────────────────────────────────────────────────────────────── */
function normalisePostcode(pc) { return String(pc || '').replace(/\s+/g, '').toUpperCase(); }
function isValidUkPostcode(pc) { return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(normalisePostcode(pc)); }
function prettyPostcode(pc) { const n = normalisePostcode(pc); return n.length > 3 ? `${n.slice(0, -3)} ${n.slice(-3)}` : n; }

/* ── Distance / travel (same formula as booking.html & scheduling.html) ───── */
const AVG_SPEED_KMH = 53.1;
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function driveMinutes(a, b) {
  const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
  return Math.max(1, Math.round((km * 1.4 / AVG_SPEED_KMH) * 60));
}

/* ── Network helper with timeout ──────────────────────────────────────────── */
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ── Geocoding (postcodes.io) with a warm-instance cache ──────────────────── */
const geoCache = new Map(); // normalised postcode -> {lat, lon} | null
const GEO_CACHE_MAX = 5000;

function cacheGeo(key, val) {
  if (geoCache.size >= GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value);
  geoCache.set(key, val);
}

// Returns Map(normalisedPostcode -> {lat, lon} | null). Never throws for "not found";
// throws only if the service itself is unreachable for postcodes we have no cache for.
async function geocodeMany(postcodes) {
  const result = new Map();
  const todo = [];
  for (const raw of new Set((postcodes || []).map(normalisePostcode).filter(Boolean))) {
    if (geoCache.has(raw)) result.set(raw, geoCache.get(raw));
    else todo.push(raw);
  }
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const res = await fetchWithTimeout('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: chunk }),
    });
    if (!res.ok) throw new Error(`Postcode lookup failed (${res.status}).`);
    const data = await res.json();
    const seen = new Set();
    for (const r of (data.result || [])) {
      const key = normalisePostcode(r.query);
      seen.add(key);
      const val = r.result && typeof r.result.latitude === 'number'
        ? { lat: r.result.latitude, lon: r.result.longitude } : null;
      cacheGeo(key, val);
      result.set(key, val);
    }
    chunk.forEach(k => { if (!seen.has(k)) { cacheGeo(k, null); result.set(k, null); } });
  }
  return result;
}

async function geocodeOne(postcode) {
  const key = normalisePostcode(postcode);
  const m = await geocodeMany([key]);
  return m.get(key) || null;
}

module.exports = {
  parseJobDate, isISODate, addDays, daysBetween, isWeekend, eachDay, londonToday, spannedWorkingDates,
  normalisePostcode, isValidUkPostcode, prettyPostcode,
  haversineKm, driveMinutes, fetchWithTimeout, geocodeMany, geocodeOne,
  _geoCache: geoCache,
};
