'use strict';
/**
 * Webhook helpers: URL validation (SSRF guard), signing, change detection, delivery.
 *
 * Signing secrets are NOT stored. Each subscription's secret is derived from a server-side
 * master secret (GEKO_WEBHOOK_SECRET) and the subscription id, so nothing sensitive lives in
 * the database. It is shown to the partner once, when the subscription is created.
 */
const crypto = require('crypto');
const { parseJobDate, fetchWithTimeout } = require('./util');

const EVENT_TYPES = ['job.rescheduled', 'job.status_changed', 'job.confirmation_changed'];
const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_MIN = [1, 5, 30, 120, 720]; // delay before attempt 2,3,4,5,6

/* ── URL validation ───────────────────────────────────────────────────────── */
function validateWebhookUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'url is required.' };
  if (raw.length > 2048) return { ok: false, error: 'url is too long.' };
  let u;
  try { u = new URL(raw.trim()); } catch (_) { return { ok: false, error: 'url is not a valid URL.' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'url must use https.' };
  if (u.username || u.password) return { ok: false, error: 'url must not contain credentials.' };
  if (u.port && u.port !== '443') return { ok: false, error: 'url must use the default https port (443).' };
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[')) return { ok: false, error: 'url must use a hostname, not an IP address.' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ok: false, error: 'url must use a hostname, not an IP address.' };
  if (!host.includes('.')) return { ok: false, error: 'url must use a public hostname.' };
  if (/(^|\.)(localhost|local|internal|lan|intranet|home\.arpa)$/.test(host)) {
    return { ok: false, error: 'url must use a public hostname.' };
  }
  u.hash = '';
  return { ok: true, url: u.toString() };
}

function parseEvents(input) {
  if (input === undefined || input === null) return { ok: true, events: EVENT_TYPES.slice() };
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: 'events must be a non-empty array.' };
  const bad = input.filter(e => !EVENT_TYPES.includes(e));
  if (bad.length) return { ok: false, error: `Unknown event type(s): ${bad.join(', ')}. Valid: ${EVENT_TYPES.join(', ')}.` };
  return { ok: true, events: [...new Set(input)] };
}

/* ── Secrets & signatures ─────────────────────────────────────────────────── */
function deriveSecret(master, subscriptionId) {
  return 'whsec_' + crypto.createHmac('sha256', master).update(`webhook:${subscriptionId}`).digest('hex');
}

function signPayload(secret, timestamp, body) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ── Change detection ─────────────────────────────────────────────────────── */
// Same normalisation the scheduler uses, so 'assigned' etc. don't create noise.
function normaliseStatus(raw) {
  if (!raw) return 'unassigned';
  const s = String(raw).toLowerCase().trim().replace(/\s+/g, '-');
  if (s === 'enroute') return 'en-route';
  if (s === 'inprogress') return 'in-progress';
  return ['complete', 'en-route', 'in-progress', 'abort'].includes(s) ? s : 'unassigned';
}

// A job is "confirmed" once Geko has allocated an engineer to it and it has a date.
// Aborted jobs are never confirmed. The scheduler does not change jobStatus when it allocates
// an engineer, so partners cannot tell from jobStatus alone; this is the signal for them.
function isConfirmed(job) {
  return Boolean(String((job && job.engineerName) || '').trim())
    && Boolean(parseJobDate(job.dateOfJob))
    && normaliseStatus(job.jobStatus) !== 'abort';
}

function snapshotOf(job) {
  return {
    dateOfJob: parseJobDate(job.dateOfJob) || '',
    jobStatus: normaliseStatus(job.jobStatus),
    confirmed: isConfirmed(job),
  };
}

// prev: stored snapshot {dateOfJob, jobStatus, confirmed?}; job: current raw job. Returns event drafts.
// Snapshots stored before "confirmed" existed have no such field; they count as not confirmed,
// so a job that was already allocated reports its confirmation once.
function detectChanges(prev, job) {
  const cur = snapshotOf(job);
  const events = [];
  if ((prev.dateOfJob || '') !== cur.dateOfJob) {
    events.push({
      type: 'job.rescheduled',
      data: { previousDate: prev.dateOfJob || null, newDate: cur.dateOfJob || null },
    });
  }
  if (normaliseStatus(prev.jobStatus) !== cur.jobStatus) {
    events.push({
      type: 'job.status_changed',
      data: { previousStatus: normaliseStatus(prev.jobStatus), status: cur.jobStatus },
    });
  }
  if (Boolean(prev.confirmed) !== cur.confirmed) {
    events.push({
      type: 'job.confirmation_changed',
      data: { previousConfirmed: Boolean(prev.confirmed), confirmed: cur.confirmed },
    });
  }
  return { events, snapshot: cur };
}

function buildEvent({ type, job, data, environment, now = new Date() }) {
  return {
    id: 'evt_' + crypto.randomBytes(10).toString('hex'),
    type,
    createdAt: now.toISOString(),
    environment,
    data: { jobId: job.jobId || job._id, projectId: job.projectId || '', ...data },
  };
}

/* ── Delivery ─────────────────────────────────────────────────────────────── */
async function deliver({ url, secret, event, timeoutMs = 5000, now = Date.now() }) {
  const body = JSON.stringify(event);
  const ts = Math.floor(now / 1000);
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      redirect: 'manual', // never follow redirects (SSRF hardening)
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Geko-Webhooks/1.0',
        'X-Geko-Event': event.type,
        'X-Geko-Delivery': event.id,
        'X-Geko-Timestamp': String(ts),
        'X-Geko-Signature': signPayload(secret, ts, body),
      },
      body,
    }, timeoutMs);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err && err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  }
}

function nextAttemptDelayMs(attemptsSoFar) {
  const mins = RETRY_DELAYS_MIN[Math.min(attemptsSoFar - 1, RETRY_DELAYS_MIN.length - 1)];
  return mins * 60 * 1000;
}

module.exports = {
  EVENT_TYPES, MAX_ATTEMPTS,
  validateWebhookUrl, parseEvents, deriveSecret, signPayload, safeEqual,
  normaliseStatus, isConfirmed, snapshotOf, detectChanges, buildEvent, deliver, nextAttemptDelayMs,
};
