// The rule language shared by scoring factors, rules, templates, Flame On rules and watchlists.
//   { all: [cond...] } | { any: [cond...] } | { not: cond } | { field, op, value }
// Ops: has hasAny hasAll hasNone (array fields) · eq ne in gt gte lt lte · matches (regex, case-insensitive) · exists

export const FIELDS = ['countries', 'topics', 'entities', 'sections', 'tier', 'sourceCount', 'urgency', 'direction', 'pct', 'casualties', 'score', 'level', 'text', 'title', 'flameOn', 'watch', 'opinion', 'noise', 'majorCountry', 'ageHours', 'tier1', 'baseScore', 'reliableCount'];
export const OPS = ['has', 'hasAny', 'hasAll', 'hasNone', 'eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'matches', 'exists'];

const reCache = new Map();
function re(src) {
  let r = reCache.get(src);
  if (!r) { r = new RegExp(src, 'iu'); reCache.set(src, r); }
  return r;
}

export function evaluate(cond, facts) {
  if (!cond) return true;
  if (Array.isArray(cond)) return cond.every(c => evaluate(c, facts));
  if (cond.all) return cond.all.every(c => evaluate(c, facts));
  if (cond.any) return cond.any.some(c => evaluate(c, facts));
  if (cond.not) return !evaluate(cond.not, facts);
  const v = facts[cond.field];
  const x = cond.value;
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v]);
  switch (cond.op) {
    case 'has': return arr.includes(x);
    case 'hasAny': return (Array.isArray(x) ? x : [x]).some(y => arr.includes(y));
    case 'hasAll': return (Array.isArray(x) ? x : [x]).every(y => arr.includes(y));
    case 'hasNone': return !(Array.isArray(x) ? x : [x]).some(y => arr.includes(y));
    case 'eq': return v === x;
    case 'ne': return v !== x;
    case 'in': return Array.isArray(x) && x.includes(v);
    case 'gt': return typeof v === 'number' && v > x;
    case 'gte': return typeof v === 'number' && v >= x;
    case 'lt': return typeof v === 'number' && v < x;
    case 'lte': return typeof v === 'number' && v <= x;
    case 'matches': return typeof v === 'string' && re(x).test(v);
    case 'exists': return x === false ? v == null : v != null;
    default: return false;
  }
}

// Validation used by `npm run validate`, the pipeline at start-up and (mirrored) the app's rule editor.
export function validateCondition(cond, path = 'if') {
  const errs = [];
  if (cond == null || typeof cond !== 'object') return [`${path}: condition must be an object`];
  if (Array.isArray(cond)) { cond.forEach((c, i) => errs.push(...validateCondition(c, `${path}[${i}]`))); return errs; }
  const keys = ['all', 'any', 'not'].filter(k => k in cond);
  if (keys.length > 1) errs.push(`${path}: use only one of all/any/not`);
  if (cond.all || cond.any) {
    const list = cond.all || cond.any;
    if (!Array.isArray(list) || !list.length) errs.push(`${path}: all/any needs a non-empty array`);
    else list.forEach((c, i) => errs.push(...validateCondition(c, `${path}.${keys[0]}[${i}]`)));
    return errs;
  }
  if (cond.not) return validateCondition(cond.not, `${path}.not`);
  if (!FIELDS.includes(cond.field)) errs.push(`${path}: unknown field "${cond.field}"`);
  if (!OPS.includes(cond.op)) errs.push(`${path}: unknown op "${cond.op}"`);
  if (cond.op === 'matches') { try { new RegExp(cond.value, 'iu'); } catch (e) { errs.push(`${path}: bad regex ${e.message}`); } }
  if (['hasAny', 'hasAll', 'hasNone', 'in'].includes(cond.op) && !Array.isArray(cond.value)) errs.push(`${path}: op ${cond.op} needs an array value`);
  return errs;
}
