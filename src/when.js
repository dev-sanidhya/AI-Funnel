'use strict';
// Understands "tomorrow 5 pm", "Saturday at 11", "in 2 hours", "kal shaam 6 baje"
// and turns it into a real timestamp in the business's time zone. Used as a
// deterministic cross-check on the LLM and as the fallback when the LLM is down.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function partsIn(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(ts).map((x) => [x.type, x.value]));
  return {
    y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second,
    wd: DAY_ABBR.indexOf(String(p.weekday).toLowerCase().slice(0, 3)),
  };
}

function offsetAt(ts, tz) {
  const p = partsIn(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ts;
}

// Local wall-clock time in `tz` to epoch milliseconds (handles DST by re-checking the offset).
function zonedEpoch(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - offsetAt(guess, tz);
  ts = guess - offsetAt(ts, tz);
  return ts;
}

// "2026-10-03T17:00" (local to tz) to epoch ms, or null.
function isoLocalToEpoch(iso, tz) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const ts = zonedEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
  return Number.isFinite(ts) ? ts : null;
}

function addDays(y, mo, d, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const DAY_PARTS = [
  [/\b(morning|subah|savere)\b/, 10, 0],
  [/\b(afternoon|dopahar)\b/, 14, 0],
  [/\b(evening|shaam|sham)\b/, 18, 0],
  [/\b(tonight|night)\b/, 20, 0],
];

// Returns { at, hasTime, approx, day } or null when no date or time is present.
//   at     epoch ms, or null if only a day was given
//   day    { y, mo, d } the local calendar day, if one was given
function parseWhen(text, nowMs = Date.now(), tz = 'Asia/Kolkata') {
  const t = ` ${String(text || '').toLowerCase().replace(/\b([ap])\.\s?m\b\.?/g, '$1m').replace(/[,.]/g, ' ').replace(/\s+/g, ' ')} `;
  const now = partsIn(nowMs, tz);

  // Relative: "in 2 hours", "in 45 minutes", "in 3 days"
  const rel = t.match(/\bin (\d+(?:\.\d+)?) ?(hours?|hrs?|minutes?|mins?|days?)\b/);
  if (rel) {
    const n = parseFloat(rel[1]);
    if (/^d/.test(rel[2])) {
      const dd = addDays(now.y, now.mo, now.d, Math.round(n));
      return { at: null, hasTime: false, approx: false, day: dd };
    }
    const ms = /^h/.test(rel[2]) ? n * 3600000 : n * 60000;
    const at = nowMs + ms;
    const p = partsIn(at, tz);
    return { at, hasTime: true, approx: false, day: { y: p.y, mo: p.mo, d: p.d } };
  }

  // Day
  let day = null;
  let tonight = false;
  if (/\b(day after tomorrow|parso|parson)\b/.test(t)) day = addDays(now.y, now.mo, now.d, 2);
  else if (/\b(tomorrow|tmrw|tmr|kal)\b/.test(t)) day = addDays(now.y, now.mo, now.d, 1);
  else if (/\b(today|aaj|tonight)\b/.test(t)) { day = { y: now.y, mo: now.mo, d: now.d }; tonight = /\btonight\b/.test(t); }
  else {
    for (let i = 0; i < 7; i++) {
      const re = new RegExp(`\\b(${DAYS[i]}|${DAY_ABBR[i]}|${DAYS[i].slice(0, 4)})\\b`);
      if (re.test(t)) {
        let diff = (i - now.wd + 7) % 7;
        if (diff === 0 && /\bnext\b/.test(t)) diff = 7;
        day = addDays(now.y, now.mo, now.d, diff);
        break;
      }
    }
  }

  // Time of day
  let h = null;
  let mi = 0;
  let approx = false;
  const m12 = t.match(/\b(\d{1,2})(?::(\d{2}))? ?(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  const m24 = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  const mBaje = t.match(/\b(\d{1,2})(?::(\d{2}))? ?(?:baje|bje)\b/);
  const mAt = t.match(/\bat (\d{1,2})(?::(\d{2}))?(?! ?(?:am|pm|a\.m|p\.m|th|st|nd|rd|%|k\b|lakh|l\b))/);
  if (m12) {
    h = +m12[1] % 12; mi = +(m12[2] || 0);
    if (/^p/.test(m12[3])) h += 12;
  } else if (m24) {
    h = +m24[1]; mi = +m24[2];
  } else if (mBaje || mAt) {
    const mm = mBaje || mAt;
    h = +mm[1]; mi = +(mm[2] || 0);
    if (h >= 1 && h <= 7) h += 12; // business hours: "at 5" means 5 pm
    else if (h === 12) h = 12;
    if (/\b(evening|shaam|sham|tonight|night)\b/.test(t) && h < 12) h += 12;
  } else if (/\b(noon|midday)\b/.test(t)) {
    h = 12;
  } else {
    for (const [re, hh, mm] of DAY_PARTS) if (re.test(t)) { h = hh; mi = mm; approx = true; break; }
    if (h === null && tonight) { h = 20; approx = true; }
  }
  if (h !== null && (h > 23 || mi > 59)) h = null;

  if (!day && h === null) return null;
  if (!day) {
    // time only: today if it is still ahead, otherwise tomorrow
    let at = zonedEpoch(now.y, now.mo, now.d, h, mi, tz);
    let dd = { y: now.y, mo: now.mo, d: now.d };
    if (at < nowMs - 5 * 60000) { dd = addDays(now.y, now.mo, now.d, 1); at = zonedEpoch(dd.y, dd.mo, dd.d, h, mi, tz); }
    return { at, hasTime: true, approx, day: dd };
  }
  if (h === null) return { at: null, hasTime: false, approx: false, day };
  return { at: zonedEpoch(day.y, day.mo, day.d, h, mi, tz), hasTime: true, approx, day };
}

// "Tomorrow, Sat 3 Oct, 5:00 PM"
function formatWhen(ts, tz = 'Asia/Kolkata', nowMs = Date.now()) {
  if (!ts) return '';
  const p = partsIn(ts, tz);
  const n = partsIn(nowMs, tz);
  const dayDiff = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(n.y, n.mo - 1, n.d)) / 86400000);
  const rel = dayDiff === 0 ? 'Today' : dayDiff === 1 ? 'Tomorrow' : dayDiff === -1 ? 'Yesterday' : '';
  const wd = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(ts);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(ts);
  return `${rel ? `${rel}, ` : ''}${wd}, ${time}`;
}

module.exports = { parseWhen, formatWhen, zonedEpoch, isoLocalToEpoch, partsIn };
