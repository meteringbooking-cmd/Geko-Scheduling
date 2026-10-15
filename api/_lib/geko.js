'use strict';
/**
 * Geko shared server helpers: Firestore REST access, API-key auth, CORS and config.
 * Same approach as api/jobs.js (Firestore REST + web API key, no firebase-admin).
 */
const { fetchWithTimeout } = require('./util');

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'geko-scheduling';
const FIREBASE_API_KEY    = process.env.FIREBASE_API_KEY    || 'AIzaSyDVy6E89BBETXvRk6H__HfjSE6k4IfqrqU';
const FIRESTORE_BASE      = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

/* ── Config (all overridable with Vercel environment variables) ───────────── */
function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}
function getConfig() {
  return {
    minNoticeDays:   intEnv('AVAILABILITY_MIN_NOTICE_DAYS', 42),   // earliest bookable = today + 6 weeks
    maxAdvanceDays:  intEnv('AVAILABILITY_MAX_ADVANCE_DAYS', 84),  // latest bookable   = today + 12 weeks
    limitedMax:      intEnv('AVAILABILITY_LIMITED_MAX', 1),        // 1..N free engineers => "limited"
    defaultRadiusMin:intEnv('AVAILABILITY_DEFAULT_RADIUS_MINS', 90),
    maxRangeDays:    intEnv('AVAILABILITY_MAX_RANGE_DAYS', 92),
    bankHolidayRegion: process.env.BANK_HOLIDAY_REGION || 'england-and-wales',
  };
}

/* ── Auth / CORS ──────────────────────────────────────────────────────────── */
function authMode(req) {
  const key = req.headers['x-api-key'] || (req.query && req.query.api_key);
  if (!key) return null;
  if (process.env.GEKO_API_KEY && key === process.env.GEKO_API_KEY) return 'live';
  if (process.env.GEKO_API_KEY_SANDBOX && key === process.env.GEKO_API_KEY_SANDBOX) return 'sandbox';
  return null;
}

function setCors(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
}

// Collection names per environment. Sandbox is fully isolated for jobs and webhook data.
function collections(mode) {
  const sfx = mode === 'sandbox' ? '_sandbox' : '';
  return {
    jobs:       `uploaded_jobs${sfx}`,
    state:      `webhook_state${sfx}`,
    subs:       `webhook_subscriptions${sfx}`,
    deliveries: `webhook_deliveries${sfx}`,
  };
}

/* ── Firestore value mapping ──────────────────────────────────────────────── */
function toFirestoreDoc(data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) fields[k] = { stringValue: '' };
    else if (typeof v === 'boolean')   fields[k] = { booleanValue: v };
    else if (typeof v === 'number')    fields[k] = { doubleValue: v };
    else                               fields[k] = { stringValue: String(v) };
  }
  return { fields };
}

function fromFirestoreDoc(doc) {
  const out = {};
  if (doc && doc.name) out._id = doc.name.split('/').pop();
  if (!doc || !doc.fields) return out;
  for (const [k, v] of Object.entries(doc.fields)) {
    if      (v.stringValue  !== undefined) out[k] = v.stringValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.doubleValue  !== undefined) out[k] = v.doubleValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue, 10);
    else out[k] = null;
  }
  return out;
}

/* ── Firestore REST operations ────────────────────────────────────────────── */
function docUrl(collection, id) {
  return `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(id)}?key=${FIREBASE_API_KEY}`;
}

async function fsError(res, what) {
  const detail = await res.text().catch(() => '');
  const err = new Error(`Firestore ${what} failed (${res.status}). ${detail.slice(0, 200)}`);
  err.status = res.status;
  return err;
}

// Returns the document data (with _id) or null when it does not exist.
async function fsGet(collection, id) {
  const res = await fetchWithTimeout(docUrl(collection, id));
  if (res.status === 404) return null;
  if (!res.ok) throw await fsError(res, 'read');
  const doc = await res.json();
  return doc.fields ? fromFirestoreDoc(doc) : null;
}

async function fsSet(collection, id, data) {
  const res = await fetchWithTimeout(docUrl(collection, id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toFirestoreDoc(data)),
  });
  if (!res.ok) throw await fsError(res, 'write');
}

async function fsDelete(collection, id) {
  const res = await fetchWithTimeout(docUrl(collection, id), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw await fsError(res, 'delete');
}

// Every document in a collection (paged). `fields` limits the returned fields.
async function fsListAll(collection, fields) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ key: FIREBASE_API_KEY, pageSize: '300' });
    (fields || []).forEach(f => params.append('mask.fieldPaths', f));
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetchWithTimeout(`${FIRESTORE_BASE}/${collection}?${params.toString()}`);
    if (res.status === 404) return out;
    if (!res.ok) throw await fsError(res, 'list');
    const data = await res.json();
    (data.documents || []).forEach(d => out.push(fromFirestoreDoc(d)));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Equality query on string/boolean fields: filters = { field: value, ... }
async function fsQueryEquals(collection, filters) {
  const clauses = Object.entries(filters).map(([field, value]) => ({
    fieldFilter: {
      field: { fieldPath: field },
      op: 'EQUAL',
      value: typeof value === 'boolean' ? { booleanValue: value } : { stringValue: String(value) },
    },
  }));
  const where = clauses.length === 1 ? clauses[0] : { compositeFilter: { op: 'AND', filters: clauses } };
  const res = await fetchWithTimeout(`${FIRESTORE_BASE}:runQuery?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }], where } }),
  });
  if (!res.ok) throw await fsError(res, 'query');
  const rows = await res.json();
  return (rows || []).filter(r => r.document).map(r => fromFirestoreDoc(r.document));
}

module.exports = {
  getConfig, authMode, setCors, collections,
  toFirestoreDoc, fromFirestoreDoc,
  fsGet, fsSet, fsDelete, fsListAll, fsQueryEquals,
};
