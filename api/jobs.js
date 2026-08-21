/**
 * Geko Scheduling — External Jobs API
 * Vercel Serverless Function
 *
 * Endpoint: /api/jobs
 *
 * Environment variables required (set in Vercel dashboard):
 *   FIREBASE_PROJECT_ID      — geko-scheduling
 *   FIREBASE_CLIENT_EMAIL    — from Firebase service account JSON
 *   FIREBASE_PRIVATE_KEY     — from Firebase service account JSON
 *   GEKO_API_KEY             — your chosen secret key for external callers
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ── Initialise Firebase Admin (only once per cold start) ─────────────────────
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// ── CORS helper ───────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
}

// ── Auth helper ───────────────────────────────────────────────────────────────
function authorised(req) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  return key === process.env.GEKO_API_KEY;
}

// ── Auto-generate a JOB-XXXXX ID ─────────────────────────────────────────────
async function nextJobId() {
  const snap = await db.collection('uploaded_jobs').get();
  let max = 0;
  snap.forEach(d => {
    const n = parseInt((d.id || '').replace('JOB-', ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return `JOB-${String(max + 1).padStart(5, '0')}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Authenticate
  if (!authorised(req)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorised. Provide a valid X-API-Key header.',
    });
  }

  // ── POST /api/jobs — Create a job ──────────────────────────────────────────
  if (req.method === 'POST') {
    const {
      jobId,
      title       = '',
      firstName   = '',
      lastName    = '',
      addressLine1= '',
      town        = '',
      postcode    = '',
      phone       = '',
      email       = '',
      jobType     = '',
      jobLength   = '',
      jobDate     = '',
    } = req.body || {};

    // Required field validation
    if (!jobType) {
      return res.status(400).json({ success: false, error: 'jobType is required.' });
    }
    if (!postcode) {
      return res.status(400).json({ success: false, error: 'postcode is required.' });
    }

    // Determine document ID
    const rawId = jobId ? String(jobId).trim() : null;
    const docId = rawId || (await nextJobId());

    // Check for duplicate
    const existing = await db.collection('uploaded_jobs').doc(docId).get();
    if (existing.exists) {
      return res.status(409).json({
        success: false,
        error: `A job with ID "${docId}" already exists.`,
        jobId:  docId,
      });
    }

    const customerName = [title, firstName, lastName].filter(Boolean).join(' ').trim();

    const record = {
      jobId,
      title,
      firstName,
      lastName,
      customerName,
      addressLine1,
      cityTown:      town,
      postcode,
      contactNumber: phone,
      email,
      jobType,
      jobLength,
      dateOfJob:   jobDate,
      jobStatus:   'unassigned',
      uploadedAt:  new Date().toISOString(),
      source:      'api',
    };

    await db.collection('uploaded_jobs').doc(docId).set(record);

    return res.status(201).json({
      success: true,
      message: 'Job created successfully.',
      jobId:   docId,
    });
  }

  // ── GET /api/jobs?jobId=XXX — Retrieve a job ───────────────────────────────
  if (req.method === 'GET') {
    const { jobId } = req.query;

    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Provide a jobId query parameter, e.g. /api/jobs?jobId=JOB-00001',
      });
    }

    // Try exact document ID first
    const docSnap = await db.collection('uploaded_jobs').doc(jobId).get();

    if (docSnap.exists) {
      const data = docSnap.data();
      return res.status(200).json({ success: true, job: sanitise(data) });
    }

    // Fallback: query by the jobId field
    const q = await db.collection('uploaded_jobs').where('jobId', '==', jobId).limit(1).get();
    if (q.empty) {
      return res.status(404).json({ success: false, error: `Job not found: ${jobId}` });
    }

    return res.status(200).json({ success: true, job: sanitise(q.docs[0].data()) });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
};

// ── Strip internal-only fields before returning to caller ─────────────────────
function sanitise(data) {
  const {
    jobId, title, firstName, lastName, customerName,
    addressLine1, cityTown, postcode,
    contactNumber, email, jobType, jobLength, dateOfJob,
    jobStatus, uploadedAt, source,
  } = data;
  return {
    jobId, title, firstName, lastName, customerName,
    addressLine1, town: cityTown, postcode,
    phone: contactNumber, email, jobType, jobLength,
    jobDate: dateOfJob,
    jobStatus, uploadedAt, source,
  };
}
