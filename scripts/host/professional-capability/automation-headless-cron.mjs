import { fail } from './support.mjs';

function parseCronFive(cron) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) fail('INVALID_CRON', 'cron must have exactly 5 fields (min hour dom mon dow).', 400);
  const bounds = [
    [0, 59], [0, 23], [1, 31], [1, 12], [0, 7],
  ];
  const parsed = fields.map((field, index) => {
    const [lo, hi] = bounds[index];
    if (field === '*') return { raw: field, any: true, lo, hi };
    const parts = field.split(',');
    const values = [];
    for (const part of parts) {
      const stepMatch = /^(\*|\d+)(?:-(\d+))?\/(\d+)$/.exec(part);
      const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
      const numMatch = /^(\d+)$/.exec(part);
      if (stepMatch) {
        const start = stepMatch[1] === '*' ? lo : Number(stepMatch[1]);
        const end = stepMatch[2] != null ? Number(stepMatch[2]) : hi;
        const step = Number(stepMatch[3]);
        if (step < 1 || start < lo || end > hi || start > end) {
          fail('INVALID_CRON', `cron field ${index + 1} out of range.`, 400);
        }
        for (let v = start; v <= end; v += step) values.push(v);
      } else if (rangeMatch) {
        const a = Number(rangeMatch[1]);
        const b = Number(rangeMatch[2]);
        if (a < lo || b > hi || a > b) fail('INVALID_CRON', `cron field ${index + 1} range invalid.`, 400);
        for (let v = a; v <= b; v += 1) values.push(v);
      } else if (numMatch) {
        const n = Number(numMatch[1]);
        if (n < lo || n > hi) fail('INVALID_CRON', `cron field ${index + 1} value ${n} out of [${lo},${hi}].`, 400);
        values.push(n);
      } else {
        fail('INVALID_CRON', `cron field ${index + 1} token invalid: ${part}`, 400);
      }
    }
    return { raw: field, any: false, values: Object.freeze([...new Set(values)].sort((a, b) => a - b)), lo, hi };
  });
  return Object.freeze(parsed);
}

/** Evaluate simple pageCount comparisons: pageCount OP number. */
function evalPageCountCondition(condition, pageCount) {
  const match = /^\s*pageCount\s*(==|!=|<=|>=|<|>)\s*(\d+)\s*$/.exec(condition);
  if (!match) {
    if (/pageCount/.test(condition)) fail('INVALID_CONDITION', 'condition must be "pageCount OP number".', 400);
    return { matched: false, reason: 'no-pageCount-predicate' };
  }
  const op = match[1];
  const rhs = Number(match[2]);
  let matched = false;
  switch (op) {
    case '>': matched = pageCount > rhs; break;
    case '>=': matched = pageCount >= rhs; break;
    case '<': matched = pageCount < rhs; break;
    case '<=': matched = pageCount <= rhs; break;
    case '==': matched = pageCount === rhs; break;
    case '!=': matched = pageCount !== rhs; break;
    default: fail('INVALID_CONDITION', `unsupported op ${op}`, 400);
  }
  return { matched, op, rhs };
}


export { evalPageCountCondition, parseCronFive };

