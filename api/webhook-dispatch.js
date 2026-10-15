/**
 * Geko Scheduling — Webhook dispatcher
 *
 * Job dates and statuses are changed by the scheduler pages writing straight to Firestore,
 * so nothing server-side sees the change happen. This endpoint is the watcher: each run it
 *   1. compares every API-created job against the last snapshot we sent (date + status),
 *   2. queues a signed event per matching subscription when something changed, and
 *   3. delivers anything due (with retries: 1m, 5m, 30m, 2h, 12h, then marked failed).
 *
 * Call it on a schedule (every 1–5 minutes) from any scheduler:
 *   GET /api/webhook-dispatch      Authorization: Bearer <CRON_SECRET>
 * Delivery is at-least-once: use the event "id" (also sent as X-Geko-Delivery) to de-duplicate.
 *
 * Env: CRON_SECRET (auth for this endpoint), GEKO_WEBHOOK_SECRET (signing).
 * Note: each run reads every API-created job once (Firestore reads are billed), so prefer a
 * 5-minute interval unless near-instant delivery matters.
 */
const crypto = require('crypto');
const {
  collections, fsListAll, fsQueryEquals, fsSet, fsDelete,
} = require('./_lib/geko');
const {
  MAX_ATTEMPTS, deriveSecret, safeEqual, snapshotOf, detectChanges, buildEvent, deliver, nextAttemptDelayMs,
} = require('./_lib/webhooks');

const BUDGET_MS = 8000;     // stay inside the 10s function limit
const DELIVERY_TIMEOUT = 5000;

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

async function dispatchEnvironment(mode, { master, deadline }) {
  const cols = collections(mode);
  const stats = { subscriptions: 0, jobsChecked: 0, baselined: 0, eventsQueued: 0, delivered: 0, retrying: 0, failed: 0 };

  const subs = (await fsListAll(cols.subs)).filter(s => s.active !== false);
  stats.subscriptions = subs.length;
  if (subs.length === 0) return stats;
  const subById = new Map(subs.map(s => [s._id, s]));

  /* 1 — detect changes and queue deliveries */
  const [jobs, states] = await Promise.all([
    fsQueryEquals(cols.jobs, { source: 'api' }),
    fsListAll(cols.state),
  ]);
  const stateById = new Map(states.map(s => [s._id, s]));

  await pool(jobs, 10, async job => {
    if (Date.now() > deadline - 1500) return; // pick the rest up next run
    const id = job._id;
    stats.jobsChecked++;
    const prev = stateById.get(id);
    if (!prev) {
      await fsSet(cols.state, id, snapshotOf(job)); // first sight: record, don't notify
      stats.baselined++;
      return;
    }
    const { events, snapshot } = detectChanges(prev, job);
    if (events.length === 0) return;

    for (const draft of events) {
      const event = buildEvent({ type: draft.type, job: { ...job, jobId: job.jobId || id }, data: draft.data, environment: mode });
      for (const sub of subs) {
        if (!String(sub.events || '').split(',').includes(event.type)) continue;
        await fsSet(cols.deliveries, 'dlv_' + crypto.randomBytes(8).toString('hex'), {
          subscriptionId: sub._id,
          eventId: event.id,
          eventJson: JSON.stringify(event),
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
        stats.eventsQueued++;
      }
    }
    await fsSet(cols.state, id, snapshot); // after queueing: a crash duplicates, never loses
  });

  /* 2 — deliver everything that is due */
  const pending = await fsQueryEquals(cols.deliveries, { status: 'pending' });
  const nowIso = new Date().toISOString();
  const due = pending.filter(d => !d.nextAttemptAt || d.nextAttemptAt <= nowIso);

  await pool(due, 5, async d => {
    if (Date.now() > deadline - DELIVERY_TIMEOUT - 500) return;
    const sub = subById.get(d.subscriptionId);
    if (!sub) { await fsDelete(cols.deliveries, d._id); return; } // subscription removed/paused

    let event;
    try { event = JSON.parse(d.eventJson); } catch (_) { await fsDelete(cols.deliveries, d._id); return; }

    const result = await deliver({
      url: sub.url, secret: deriveSecret(master, sub._id), event, timeoutMs: DELIVERY_TIMEOUT,
    });
    if (result.ok) {
      await fsDelete(cols.deliveries, d._id);
      stats.delivered++;
      return;
    }
    const attempts = (Number(d.attempts) || 0) + 1;
    const base = {
      subscriptionId: d.subscriptionId, eventId: d.eventId, eventJson: d.eventJson,
      createdAt: d.createdAt, attempts, lastError: result.error || '', lastAttemptAt: new Date().toISOString(),
    };
    if (attempts >= MAX_ATTEMPTS) {
      await fsSet(cols.deliveries, d._id, { ...base, status: 'failed', nextAttemptAt: '' });
      stats.failed++;
    } else {
      await fsSet(cols.deliveries, d._id, {
        ...base, status: 'pending', nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(attempts)).toISOString(),
      });
      stats.retrying++;
    }
  });

  return stats;
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const master = process.env.GEKO_WEBHOOK_SECRET;
  if (!secret || !master) {
    return res.status(503).json({ success: false, error: 'Webhook dispatcher is not configured (CRON_SECRET / GEKO_WEBHOOK_SECRET).' });
  }
  const auth = req.headers['authorization'] || '';
  if (!safeEqual(auth, `Bearer ${secret}`)) {
    return res.status(401).json({ success: false, error: 'Unauthorised.' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const deadline = Date.now() + BUDGET_MS;
  const results = {};
  try {
    for (const mode of ['live', 'sandbox']) {
      results[mode] = await dispatchEnvironment(mode, { master, deadline });
    }
    return res.status(200).json({ success: true, results });
  } catch (err) {
    console.error('dispatch error:', err);
    return res.status(500).json({ success: false, error: 'Dispatch failed; it will retry on the next run.', results });
  }
};

module.exports.dispatchEnvironment = dispatchEnvironment;
