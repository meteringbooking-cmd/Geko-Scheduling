'use strict';
/**
 * UK bank holidays. Fetched from the official gov.uk feed and cached for 24h per warm
 * instance. If the feed is unreachable we fall back to a built-in list for England & Wales
 * (2026–2027) so availability never silently offers a bank holiday.
 */
const { fetchWithTimeout } = require('./util');

const FEED = 'https://www.gov.uk/bank-holidays.json';
const TTL_MS = 24 * 60 * 60 * 1000;

const FALLBACK_ENGLAND_WALES = [
  // 2026
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  // 2027
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
];

let cache = null; // { at, region, dates:Set }

async function getBankHolidays(region = 'england-and-wales', now = Date.now()) {
  if (cache && cache.region === region && now - cache.at < TTL_MS) return cache.dates;
  let dates = null;
  try {
    const res = await fetchWithTimeout(FEED, {}, 4000);
    if (res.ok) {
      const data = await res.json();
      const events = data && data[region] && data[region].events;
      if (Array.isArray(events) && events.length > 0) {
        dates = new Set(events.map(e => e.date).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)));
      }
    }
  } catch (_) { /* fall through to fallback */ }
  if (!dates) {
    if (cache && cache.region === region) return cache.dates;            // stale beats nothing
    dates = new Set(region === 'england-and-wales' ? FALLBACK_ENGLAND_WALES : []);
    cache = { at: now - TTL_MS + 5 * 60 * 1000, region, dates };         // retry the feed in ~5 min
    return dates;
  }
  cache = { at: now, region, dates };
  return dates;
}

function _resetCache() { cache = null; }

module.exports = { getBankHolidays, FALLBACK_ENGLAND_WALES, _resetCache };
