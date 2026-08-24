/**
 * Geko Scheduling — External Jobs API
 * Uses Firebase REST API directly — no firebase-admin, no service account needed.
 * Only requires GEKO_API_KEY environment variable.
 */

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

async function getNextJobId() {
  const url = `${FIRESTORE_BASE}/uploaded_jobs?key=${FIREBASE_API_KEY}&pageSize=300`;
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

/* ── CORS & auth helpers ──────────────────────────────────────────────────── */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
}

function authorised(req) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  return process.env.GEKO_API_KEY && key === process.env.GEKO_API_KEY;
}

/* ── Main handler ─────────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!authorised(req)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorised. Provide a valid X-API-Key header.',
    });
  }

  /* ── POST — create a job ─────────────────────────────────────────────── */
  if (req.method === 'POST') {
    const {
      jobId,
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

    const docId = (jobId ? String(jobId).trim() : '') || (await getNextJobId());

    // Duplicate check
    const checkRes = await fetch(`${FIRESTORE_BASE}/uploaded_jobs/${encodeURIComponent(docId)}?key=${FIREBASE_API_KEY}`);
    if (checkRes.ok) {
      const existing = await checkRes.json();
      if (existing.fields) {
        return res.status(409).json({ success: false, error: `Job "${docId}" already exists.`, jobId: docId });
      }
    }

    const record = {
      jobId:         docId,
      title,
      firstName,
      lastName,
      customerName:  [title, firstName, lastName].filter(Boolean).join(' ').trim(),
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
      `${FIRESTORE_BASE}/uploaded_jobs/${encodeURIComponent(docId)}?key=${FIREBASE_API_KEY}`,
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

    return res.status(201).json({ success: true, message: 'Job created successfully.', jobId: docId });
  }

  /* ── GET — retrieve a job ────────────────────────────────────────────── */
  if (req.method === 'GET') {
    const { jobId } = req.query;
    if (!jobId) {
      return res.status(400).json({ success: false, error: 'Provide a jobId query parameter, e.g. /api/jobs?jobId=JOB-00001' });
    }

    const getRes = await fetch(`${FIRESTORE_BASE}/uploaded_jobs/${encodeURIComponent(jobId)}?key=${FIREBASE_API_KEY}`);

    if (!getRes.ok) {
      return res.status(404).json({ success: false, error: `Job not found: ${jobId}` });
    }

    const doc = await getRes.json();
    if (!doc.fields) {
      return res.status(404).json({ success: false, error: `Job not found: ${jobId}` });
    }

    const d = fromFirestoreDoc(doc);
    return res.status(200).json({
      success: true,
      job: {
        jobId:        d.jobId,
        title:        d.title,
        firstName:    d.firstName,
        lastName:     d.lastName,
        customerName: d.customerName,
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
      },
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
};
