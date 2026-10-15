/**
 * Geko Scheduling — Webhook subscriptions
 *
 *   POST   /api/webhooks                       register a callback   { "url": "https://...", "events": [...]? }
 *   GET    /api/webhooks                       list your callbacks
 *   GET    /api/webhooks?id=whk_...            one callback
 *   DELETE /api/webhooks?id=whk_...            remove a callback
 *   POST   /api/webhooks?id=whk_...&action=test   send a signed test event to that callback
 *
 * Auth: X-API-Key (live or sandbox). Sandbox subscriptions only ever receive sandbox events.
 * Requires the GEKO_WEBHOOK_SECRET environment variable (any long random string).
 */
const crypto = require('crypto');
const { authMode, setCors, collections, fsGet, fsSet, fsDelete, fsListAll } = require('./_lib/geko');
const {
  validateWebhookUrl, parseEvents, deriveSecret, deliver,
} = require('./_lib/webhooks');

const MAX_SUBSCRIPTIONS = 5;

const publicSub = s => ({
  id: s._id,
  url: s.url,
  events: String(s.events || '').split(',').filter(Boolean),
  active: s.active !== false,
  createdAt: s.createdAt,
});

module.exports = async function handler(req, res) {
  setCors(res, 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const mode = authMode(req);
  if (!mode) {
    return res.status(401).json({ success: false, error: 'Unauthorised. Provide a valid X-API-Key header.' });
  }
  const cols = collections(mode);
  const master = process.env.GEKO_WEBHOOK_SECRET;
  const { id, action } = req.query || {};

  try {
    /* ── GET: list / fetch one ─────────────────────────────────────────── */
    if (req.method === 'GET') {
      if (id) {
        const sub = await fsGet(cols.subs, id);
        if (!sub) return res.status(404).json({ success: false, error: `Webhook not found: ${id}` });
        return res.status(200).json({ success: true, webhook: publicSub(sub), environment: mode });
      }
      const subs = await fsListAll(cols.subs);
      return res.status(200).json({
        success: true, count: subs.length, webhooks: subs.map(publicSub), environment: mode,
      });
    }

    /* ── DELETE ────────────────────────────────────────────────────────── */
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ success: false, error: 'Provide the webhook id, e.g. DELETE /api/webhooks?id=whk_...' });
      const sub = await fsGet(cols.subs, id);
      if (!sub) return res.status(404).json({ success: false, error: `Webhook not found: ${id}` });
      await fsDelete(cols.subs, id);
      return res.status(200).json({ success: true, message: 'Webhook deleted.', id, environment: mode });
    }

    /* ── POST ──────────────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      if (!master) {
        return res.status(503).json({ success: false, error: 'Webhooks are not enabled on this server yet.' });
      }

      // Send a test event
      if (action === 'test') {
        if (!id) return res.status(400).json({ success: false, error: 'Provide the webhook id: POST /api/webhooks?id=whk_...&action=test' });
        const sub = await fsGet(cols.subs, id);
        if (!sub) return res.status(404).json({ success: false, error: `Webhook not found: ${id}` });
        const event = {
          id: 'evt_' + crypto.randomBytes(10).toString('hex'),
          type: 'webhook.test',
          createdAt: new Date().toISOString(),
          environment: mode,
          data: { message: 'This is a test event from Geko.' },
        };
        const result = await deliver({ url: sub.url, secret: deriveSecret(master, id), event });
        return res.status(200).json({
          success: true, delivered: result.ok, responseStatus: result.status || null,
          error: result.ok ? undefined : result.error, eventId: event.id,
        });
      }

      // Register a new callback
      const body = req.body || {};
      const v = validateWebhookUrl(body.url);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error });
      const ev = parseEvents(body.events);
      if (!ev.ok) return res.status(400).json({ success: false, error: ev.error });

      const existing = await fsListAll(cols.subs);
      if (existing.some(s => s.url === v.url)) {
        return res.status(409).json({ success: false, error: 'A webhook for this URL already exists.' });
      }
      if (existing.length >= MAX_SUBSCRIPTIONS) {
        return res.status(400).json({ success: false, error: `Limit of ${MAX_SUBSCRIPTIONS} webhooks reached. Delete one first.` });
      }

      const subId = 'whk_' + crypto.randomBytes(8).toString('hex');
      const createdAt = new Date().toISOString();
      await fsSet(cols.subs, subId, { url: v.url, events: ev.events.join(','), active: true, createdAt });

      return res.status(201).json({
        success: true,
        message: 'Webhook registered. Store the signing secret now; it is not shown again.',
        webhook: {
          id: subId, url: v.url, events: ev.events, active: true, createdAt,
          secret: deriveSecret(master, subId),
        },
        environment: mode,
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  } catch (err) {
    console.error('webhooks error:', err);
    return res.status(500).json({ success: false, error: 'Something went wrong. Please retry shortly.' });
  }
};

