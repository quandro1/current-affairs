// Time-zone helpers (no dependencies). All storage is UTC ISO; user-facing schedule is in prefs.timezone.
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function localParts(instant, tz) {
  const d = new Date(instant);
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, year: +p.year, month: +p.month, day: +p.day, dow: p.weekday.slice(0, 3).toLowerCase(), minutes: +p.hour * 60 + +p.minute };
}

function offsetMs(instantMs, tz) {
  const p = localParts(instantMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
  return asUtc - Math.floor(instantMs / 60e3) * 60e3;
}

// Local wall-clock date ("YYYY-MM-DD") + "HH:MM" in tz -> UTC Date.
export function zonedToUtc(date, hm, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // second pass handles DST edges
  return new Date(t);
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

export function inQuietHours(instant, q, tz) {
  if (!q?.enabled) return false;
  const cur = localParts(instant, tz).minutes, s = toMin(q.start), e = toMin(q.end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

export function quietEnds(instant, q, tz) {
  const p = localParts(instant, tz);
  const e = toMin(q.end);
  const day = p.minutes < e ? p.date : addDays(p.date, 1);
  return zonedToUtc(day, q.end, tz);
}

export function fmtLocal(instant, tz, opts = {}) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(instant));
}

export { DOW };
