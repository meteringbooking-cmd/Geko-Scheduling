/**
 * Geko Scheduling — External Jobs API
 * Uses Firebase REST API directly — no firebase-admin, no service account needed.
 *
 * Two API keys are supported, set as Vercel environment variables:
 *   GEKO_API_KEY          — live key. Reads/writes the real "uploaded_jobs" collection.
 *   GEKO_API_KEY_SANDBOX  — sandbox key. Reads/writes an isolated "uploaded_jobs_sandbox"
 *                            collection so partners can test integrations without touching
 *                            production data or live job numbering.
 * Whichever key is presented in X-API-Key decides which collection a request hits; every
 * response includes "environment": "live" | "sandbox" so callers can double-check.
 */

const { parseJobDate } = require('./_lib/util');

const FIREBASE_PROJECT_ID = 'geko-scheduling';
const FIREBASE_API_KEY    = 'AIzaSyDVy6E89BBETXvRk6H__HfjSE6k4IfqrqU';
const FIRESTORE_BASE      = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

/* ── Firestore REST helpers ───────────────────────────────────────────────── */
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
  if (!doc.fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    if      (v.stringValue  !== undefined) out[k] = v.stringValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.doubleValue  !== undefined) out[k] = v.doubleValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
    else out[k] = null;
  }
  return out;
}

async function getNextJobId(collection) {
  const url = `${FIRESTORE_BASE}/${collection}?key=${FIREBASE_API_KEY}&pageSize=300`;
  const res  = await fetch(url);
  if (!res.ok) return 'JOB-00001';
  const data = await res.json();
  let max = 0;
  (data.documents || []).forEach(d => {
    const name = d.name.split('/').pop();
    const n    = parseInt(name.replace('JOB-', ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return `JOB-${String(max + 1).padStart(5, '0')}`;
}

// Query `collection` for every document where `field` == `value`.
// Used for projectId (one project can span several jobs for the same customer).
async function queryByField(collection, field, value) {
  const url = `${FIRESTORE_BASE}:runQuery?key=${FIREBASE_API_KEY}`;
  const body = {
    structuredQuery: {
      from:  [{ collectionId: collection }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op:    'EQUAL',
          value: { stringValue: value },
        },
      },
    },
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) return [];

  const rows = await res.json();
  return (rows || [])
    .filter(r => r.document)
    .map(r => fromFirestoreDoc(r.document));
}

// Shape a raw Firestore record into the public job object returned by GET.
function shapeJob(d) {
  return {
    jobId:        d.jobId,
    projectId:    d.projectId || '',
    title:        d.title,
    firstName:    d.firstName,
    lastName:     d.lastName,
    customerName: d.customerName,
    address:      d.address || [d.addressLine1, d.cityTown].filter(Boolean).join(', '),
    addressLine1: d.addressLine1,
    town:         d.cityTown,
    postcode:     d.postcode,
    phone:        d.contactNumber,
    email:        d.email,
    jobType:      d.jobType,
    jobLength:    d.jobLength,
    jobDate:      d.dateOfJob,
    jobStatus:    d.jobStatus,
    uploadedAt:   d.uploadedAt,
    source:       d.source,
  };
}

/* ── CORS & auth helpers ──────────────────────────────────────────────────── */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
}

// Returns 'live', 'sandbox', or null depending on which configured key (if any) was presented.
function authMode(req) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return null;
  if (process.env.GEKO_API_KEY && key === process.env.GEKO_API_KEY) return 'live';
  if (process.env.GEKO_API_KEY_SANDBOX && key === process.env.GEKO_API_KEY_SANDBOX) return 'sandbox';
  return null;
}

/* ── Main handler ─────────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const mode = authMode(req);
  if (!mode) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorised. Provide a valid X-API-Key header.',
    });
  }
  const collection = mode === 'sandbox' ? 'uploaded_jobs_sandbox' : 'uploaded_jobs';

  /* ── POST — create a job ─────────────────────────────────────────────── */
  if (req.method === 'POST') {
    const {
      jobId,
      projectId    = '',
      title        = '',
      firstName    = '',
      lastName     = '',
      addressLine1 = '',
      town         = '',
      postcode     = '',
      phone        = '',
      email        = '',
      jobType      = '',
      jobLength    = '',
      jobDate      = '',
    } = req.body || {};

    if (!jobType)   return res.status(400).json({ success: false, error: 'jobType is required.' });
    if (!postcode)  return res.status(400).json({ success: false, error: 'postcode is required.' });

    const docId = (jobId ? String(jobId).trim() : '') || (await getNextJobId(collection));

    // Duplicate check
    const checkRes = await fetch(`${FIRESTORE_BASE}/${collection}/${encodeURIComponent(docId)}?key=${FIREBASE_API_KEY}`);
    if (checkRes.ok) {
      const existing = await checkRes.json();
      if (existing.fields) {
        return res.status(409).json({ success: false, error: `Job "${docId}" already exists.`, jobId: docId });
      }
    }

    const addressCombined = [addressLine1, town].filter(Boolean).join(', ');

    const record = {
      jobId:         docId,
      projectId,
      title,
      firstName,
      lastName,
      customerName:  [title, firstName, lastName].filter(Boolean).join(' ').trim(),
      address:       addressCombined || addressLine1,
      addressLine1,
      cityTown:      town,
      postcode,
      contactNumber: phone,
      email,
      jobType,
      jobLength,
      dateOfJob:     jobDate,
      jobStatus:     'unassigned',
      uploadedAt:    new Date().toISOString(),
      source:        'api',
    };

    const writeRes = await fetch(
      `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(docId)}?key=${FIREBASE_API_KEY}`,
      {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(toFirestoreDoc(record)),
      }
    );

    if (!writeRes.ok) {
      const err = await writeRes.json().catch(() => ({}));
      return res.status(500).json({ success: false, error: 'Firestore write failed.', detail: err });
    }

    // Webhook baseline: remember the date/status we created the job with, so a later move is
    // reported as a change (see api/webhook-dispatch.js). Best effort — never fails the create.
    try {
      const stateCollection = mode === 'sandbox' ? 'webhook_state_sandbox' : 'webhook_state';
      await fetch(`${FIRESTORE_BASE}/${stateCollection}/${encodeURIComponent(docId)}?key=${FIREBASE_API_KEY}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(toFirestoreDoc({ dateOfJob: parseJobDate(jobDate) || '', jobStatus: 'unassigned' })),
      });
    } catch (_) { /* ignore */ }

    return res.status(201).json({ success: true, message: 'Job created successfully.', jobId: docId, environment: mode });
  }

  /* ── GET — retrieve a job, or every job in a project ─────────────────── */
  if (req.method === 'GET') {
    const { jobId, projectId } = req.query;

    // Project ID lookup — returns every job (e.g. survey, install, aftercare)
    // that was created under this projectId, for the same customer.
    if (projectId) {
      const rows = await queryByField(collection, 'projectId', projectId);
      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: `No jobs found for projectId: ${projectId}` });
      }
      return res.status(200).json({
        success:     true,
        projectId,
        count:       rows.length,
        jobs:        rows.map(shapeJob),
        environment: mode,
      });
    }

    if (!jobId) {
      return res.status(400).json({ success: false, error: 'Provide a jobId or projectId query parameter, e.g. /api/jobs?jobId=JOB-00001' });
    }

    const getRes = await fetch(`${FIRESTORE_BASE}/${collection}/${encodeURIComponent(jobId)}?key=${FIREBASE_API_KEY}`);

    if (!getRes.ok) {
      return res.status(404).json({ success: false, error: `Job not found: ${jobId}` });
    }

    const doc = await getRes.json();
    if (!doc.fields) {
      return res.status(404).json({ success: false, error: `Job not found: ${jobId}` });
    }

    const d = fromFirestoreDoc(doc);
    return res.status(200).json({ success: true, job: shapeJob(d), environment: mode });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
};
