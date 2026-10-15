/**
 * Geko Scheduling — Survey Availability API
 *
 *   GET /api/availability?postcode=L18%201DG&from=2026-11-02&to=2026-11-27
 *
 * Returns one entry per day: { date, status, freeSlots } where status is
 *   available | limited | full | closed   (closed carries a "reason")
 * Counts only — no engineer details are ever returned.
 *
 * Auth: same X-API-Key as /api/jobs (live or sandbox key).
 * Tunables (Vercel env vars): AVAILABILITY_MIN_NOTICE_DAYS (42), AVAILABILITY_MAX_ADVANCE_DAYS (84),
 *   AVAILABILITY_LIMITED_MAX (1), AVAILABILITY_DEFAULT_RADIUS_MINS (90), BANK_HOLIDAY_REGION.
 */
const { getConfig, authMode, setCors, collections, fsListAll } = require('./_lib/geko');
const {
  isISODate, addDays, daysBetween, londonToday, isValidUkPostcode, prettyPostcode,
  normalisePostcode, geocodeMany,
} = require('./_lib/util');
const { getBankHolidays } = require('./_lib/bankholidays');
const { computeAvailability } = require('./_lib/availability');

const bad = (res, msg) => res.status(400).json({ success: false, error: msg });

module.exports = async function handler(req, res) {
  setCors(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const mode = authMode(req);
  if (!mode) {
    return res.status(401).json({ success: false, error: 'Unauthorised. Provide a valid X-API-Key header.' });
  }
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed.' });

  const config = getConfig();
  const today = londonToday();
  const earliest = addDays(today, config.minNoticeDays);
  const latest = addDays(today, config.maxAdvanceDays);

  const { postcode } = req.query;
  if (!postcode) return bad(res, 'postcode is required, e.g. /api/availability?postcode=L18 1DG');
  if (!isValidUkPostcode(postcode)) return bad(res, 'postcode is not a valid UK postcode.');

  const from = req.query.from || earliest;
  const to = req.query.to || latest;
  if (!isISODate(from) || !isISODate(to)) return bad(res, 'from and to must be dates in YYYY-MM-DD format.');
  if (to < from) return bad(res, 'to must be on or after from.');
  if (daysBetween(from, to) + 1 > config.maxRangeDays) {
    return bad(res, `Date range too large. Request at most ${config.maxRangeDays} days at a time.`);
  }

  try {
    const cols = collections(mode);

    // Customer location (a postcode that doesn't exist is the caller's mistake, not ours).
    const custMap = await geocodeMany([postcode]);
    const customer = custMap.get(normalisePostcode(postcode));
    if (!customer) return bad(res, 'postcode was not recognised.');

    const [engineerDocs, jobDocs, absenceDocs, bankHolidays] = await Promise.all([
      fsListAll('userdatabase', ['name', 'role', 'postcode', 'isochroneMinutes']),
      fsListAll(cols.jobs, ['engineerName', 'dateOfJob', 'jobLength', 'jobStatus', 'postcode']),
      fsListAll('absences', ['engineerName', 'date']),
      getBankHolidays(config.bankHolidayRegion),
    ]);

    const rawEngineers = engineerDocs.filter(d =>
      d.name && d.postcode && String(d.role || '').toLowerCase() === 'engineer');

    // Geocode engineer home postcodes and the postcodes of jobs still awaiting an engineer.
    const unassignedJobs = jobDocs.filter(j => !String(j.engineerName || '').trim() && j.postcode);
    const geo = await geocodeMany([
      ...rawEngineers.map(e => e.postcode),
      ...unassignedJobs.map(j => j.postcode),
    ]);

    const engineers = rawEngineers.map(e => ({
      name: e.name,
      coords: geo.get(normalisePostcode(e.postcode)) || null,
      isochroneMinutes: Number(e.isochroneMinutes) || 0,
    }));
    const jobs = jobDocs.map(j => ({
      engineerName: j.engineerName,
      dateOfJob: j.dateOfJob,
      jobLength: j.jobLength,
      jobStatus: j.jobStatus,
      coords: j.postcode ? (geo.get(normalisePostcode(j.postcode)) || null) : null,
    }));

    const out = computeAvailability({
      customer, engineers, jobs, absences: absenceDocs, bankHolidays, from, to, today, config,
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      success: true,
      postcode: prettyPostcode(postcode),
      covered: out.covered,
      window: out.window,
      days: out.days,
      generatedAt: new Date().toISOString(),
      environment: mode,
    });
  } catch (err) {
    console.error('availability error:', err);
    return res.status(502).json({
      success: false,
      error: 'Availability is temporarily unavailable. Please retry shortly.',
    });
  }
};
