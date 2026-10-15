'use strict';
/**
 * Survey availability maths (pure functions — no network, easy to test).
 *
 * Model (mirrors the Henrie booking page, extended):
 *  - A "slot" is one eligible engineer who is free on that day.
 *  - Eligible = within the engineer's travel radius of the customer postcode
 *    (isochroneMinutes if set, otherwise the default radius), using the same drive-time
 *    formula as the scheduler.
 *  - An engineer is not free if a job spans that day or they are absent.
 *  - Jobs with no engineer yet (e.g. created through the API) still consume capacity:
 *    each one reserves one engineer who could reach it (bipartite matching), so the
 *    calendar tightens as soon as a booking is made, not only once it is assigned.
 *  - Weekends, UK bank holidays and days outside the booking window are "closed".
 */
const { addDays, isWeekend, eachDay, parseJobDate, spannedWorkingDates, driveMinutes } = require('./util');

const key = s => String(s || '').trim().toLowerCase();

function radiusFor(engineer, defaultRadius) {
  return engineer.isochroneMinutes > 0 ? engineer.isochroneMinutes : defaultRadius;
}

function canReach(engineer, coords, defaultRadius) {
  if (!engineer.coords || !coords) return false;
  return driveMinutes(engineer.coords, coords) <= radiusFor(engineer, defaultRadius);
}

// Kuhn's augmenting-path matching. jobsAdj: array (per job) of arrays of engineer keys.
function makeMatcher() {
  const matchOfEngineer = new Map(); // engineerKey -> job index
  let adj = [];
  function tryJob(j, seen) {
    for (const e of adj[j]) {
      if (seen.has(e)) continue;
      seen.add(e);
      if (!matchOfEngineer.has(e) || tryJob(matchOfEngineer.get(e), seen)) {
        matchOfEngineer.set(e, j);
        return true;
      }
    }
    return false;
  }
  return {
    add(candidates) { adj.push(candidates); return tryJob(adj.length - 1, new Set()); },
  };
}

/**
 * @param {object} p
 * @param {{lat:number,lon:number}} p.customer  customer coordinates (null => not covered)
 * @param {Array<{name:string,coords:?{lat,lon},isochroneMinutes:number}>} p.engineers
 * @param {Array<{engineerName:string,dateOfJob:string,jobLength:any,jobStatus:string,coords:?{lat,lon}}>} p.jobs
 * @param {Array<{engineerName:string,date:string}>} p.absences
 * @param {Set<string>} p.bankHolidays   ISO dates
 * @param {string} p.from  ISO
 * @param {string} p.to    ISO
 * @param {string} p.today ISO (UK today)
 * @param {object} p.config from getConfig()
 */
function computeAvailability({ customer, engineers, jobs, absences, bankHolidays, from, to, today, config }) {
  const earliest = addDays(today, config.minNoticeDays);
  const latest = addDays(today, config.maxAdvanceDays);

  const located = engineers.filter(e => e.coords && e.name);
  const eligible = customer
    ? located.filter(e => canReach(e, customer, config.defaultRadiusMin)).map(e => key(e.name))
    : [];
  const covered = eligible.length > 0;
  const eligibleSet = new Set(eligible);

  // Days an engineer is tied up by an already-assigned job.
  const busy = new Map(); // engKey -> Set(iso)
  // Jobs awaiting an engineer, per day: [{ candidates: Set(engKey) }]
  const pendingByDay = new Map();

  const range = new Set(eachDay(from, to));
  for (const job of jobs) {
    if (key(job.jobStatus) === 'abort') continue;
    const start = parseJobDate(job.dateOfJob);
    if (!start) continue;
    const days = spannedWorkingDates(start, job.jobLength);
    const eng = key(job.engineerName);
    if (eng) {
      if (!busy.has(eng)) busy.set(eng, new Set());
      days.forEach(d => busy.get(eng).add(d));
    } else {
      // Unassigned: any engineer that could reach it. If its postcode can't be located we
      // can't know who could take it, so assume the worst case for this customer (it needs
      // one of the engineers who serve them) rather than risk offering a slot that isn't there.
      const candidates = job.coords
        ? located.filter(e => canReach(e, job.coords, config.defaultRadiusMin)).map(e => key(e.name))
        : eligible.slice();
      if (candidates.length === 0) continue; // nobody could take it, so it blocks nobody
      days.filter(d => range.has(d)).forEach(d => {
        if (!pendingByDay.has(d)) pendingByDay.set(d, []);
        pendingByDay.get(d).push(candidates);
      });
    }
  }

  const absent = new Set(absences.map(a => `${key(a.engineerName)}|${a.date}`));

  const days = eachDay(from, to).map(date => {
    const closed = reason => ({ date, status: 'closed', freeSlots: 0, reason });
    if (date < earliest || date > latest) return closed('outside_window');
    if (isWeekend(date)) return closed('weekend');
    if (bankHolidays.has(date)) return closed('bank_holiday');
    if (!covered) return closed('no_coverage');

    const free = e => !(busy.get(e) && busy.get(e).has(date)) && !absent.has(`${e}|${date}`);
    const freeAll = new Set(located.map(e => key(e.name)).filter(free));

    // Reserve engineers for jobs that are booked but not yet assigned.
    const matcher = makeMatcher();
    (pendingByDay.get(date) || []).forEach(cands => matcher.add(cands.filter(c => freeAll.has(c))));

    // How many more survey jobs at the customer's postcode still fit?
    const customerCands = [...freeAll].filter(e => eligibleSet.has(e));
    let freeSlots = 0;
    while (freeSlots < customerCands.length && matcher.add(customerCands)) freeSlots++;

    const status = freeSlots === 0 ? 'full' : freeSlots <= config.limitedMax ? 'limited' : 'available';
    return { date, status, freeSlots };
  });

  return {
    covered,
    window: {
      earliestBookableDate: earliest,
      latestBookableDate: latest,
      minNoticeDays: config.minNoticeDays,
      maxAdvanceDays: config.maxAdvanceDays,
    },
    days,
  };
}

module.exports = { computeAvailability, canReach };
