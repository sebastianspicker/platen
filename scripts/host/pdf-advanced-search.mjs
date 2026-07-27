import { normalizePdfAdvancedSearch, PDF_ADVANCED_SEARCH_PROFILE } from './pdf-advanced-search-contract.mjs';
export { PDF_ADVANCED_SEARCH_PROFILE };

const MAX_WILDCARD_SPAN = 256;
const MAX_WILDCARD_TOKENS = 64;
const MAX_MATCH_STATES = 100_000;
const MAX_SEARCH_STEPS = 16_000_000;
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message) { return failure('UNSUPPORTED_PDF_ADVANCED_SEARCH', message); }
function codePoints(value) { return [...value]; }
function letterNumberUnderscore(value) { return /^[\p{L}\p{N}_]$/u.test(value); }
function boundaries(text, start, end) { return (start === 0 || !letterNumberUnderscore(text[start - 1])) && (end === text.length || !letterNumberUnderscore(text[end])); }
function folded(value, caseSensitive) {
  const points = codePoints(value); const output = []; const starts = []; const ends = []; let offset = 0;
  for (const point of points) { const start = offset; offset += point.length; const normalized = caseSensitive ? point : point.toLocaleLowerCase('und'); const normalizedPoints = codePoints(normalized); if (!caseSensitive && normalizedPoints.length !== 1) throw unsupported('Case folding would expand a character and invalidate UTF-16 offsets.'); output.push(...normalizedPoints); for (const ignored of normalizedPoints) { starts.push(start); ends.push(offset); } }
  return { points: output, starts, ends, original: points };
}
function wildcardTokens(query) {
  const tokens = []; for (const point of codePoints(query)) { if (point === '*' && tokens.at(-1) === '*') continue; tokens.push(point); }
  if (tokens.filter((token) => token === '*' || token === '?').length > MAX_WILDCARD_TOKENS) throw unsupported('Wildcard token count exceeds the deterministic bound.');
  return tokens;
}
function matchWildcard(points, tokens, start, globalBudget) {
  const memo = new Map(); let states = 0;
  function solve(tokenIndex, position) {
    const key = `${tokenIndex}:${position}`; if (memo.has(key)) return memo.get(key); if (++states > MAX_MATCH_STATES || ++globalBudget.steps > MAX_SEARCH_STEPS) throw unsupported('Wildcard matching exceeded its deterministic work bound.');
    if (tokenIndex === tokens.length) { const result = position; memo.set(key, result); return result; }
    const token = tokens[tokenIndex]; let result = null;
    if (token === '*') { const limit = Math.min(points.length, position + MAX_WILDCARD_SPAN); for (let next = position; next <= limit; next += 1) { result = solve(tokenIndex + 1, next); if (result !== null) break; } }
    else if (position < points.length && (token === '?' || token === points[position])) result = solve(tokenIndex + 1, position + 1);
    memo.set(key, result); return result;
  }
  return solve(0, start);
}
function literalEnd(points, query, start, budget) { if (start + query.length > points.length) return null; for (let index = 0; index < query.length; index += 1) { if (++budget.steps > MAX_SEARCH_STEPS) throw unsupported('Search exceeded its deterministic work bound.'); if (points[start + index] !== query[index]) return null; } return start + query.length; }
function snippet(text, starts, ends, start, end, context) { const from = Math.max(0, start - context); const to = Math.min(starts.length, end + context); return Object.freeze({ text: text.slice(from === 0 ? 0 : starts[from], to === 0 ? 0 : ends[to - 1]), start: from === 0 ? 0 : starts[from], end: to === 0 ? 0 : ends[to - 1] }); }
function searchPage(page, request, budget, retainLimit) {
  const source = folded(page.text, request.caseSensitive); const queryFolded = folded(request.query, request.caseSensitive).points; const queryPoints = request.mode === 'wildcard' ? wildcardTokens(queryFolded.join('')) : queryFolded; const matches = []; let totalMatches = 0;
  let position = 0; while (position < source.points.length) {
    if (++budget.steps > MAX_SEARCH_STEPS) throw unsupported('Search exceeded its deterministic work bound.');
    const end = request.mode === 'literal' ? literalEnd(source.points, queryPoints, position, budget) : matchWildcard(source.points, queryPoints, position, budget);
    if (end !== null && end > position && (!request.wholeWord || boundaries(source.points, position, end))) {
      totalMatches += 1; if (matches.length < retainLimit) { const startOffset = source.starts[position]; const endOffset = source.ends[end - 1]; matches.push(Object.freeze({ page: page.page, start: startOffset, end: endOffset, text: page.text.slice(startOffset, endOffset), snippet: snippet(page.text, source.starts, source.ends, position, end, request.context) })); } position = end;
    } else position += 1;
  }
  return { matches, totalMatches };
}

export function searchPdfAdvancedText(value) {
  const request = normalizePdfAdvancedSearch(value); const all = []; let totalMatches = 0; const budget = { steps: 0 };
  for (const page of request.pages) { const pageResult = searchPage(page, request, budget, request.maxResults - all.length); totalMatches += pageResult.totalMatches; all.push(...pageResult.matches); }
  return Object.freeze({ profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256: request.sourceSha256, query: request.query, mode: request.mode, caseSensitive: request.caseSensitive, wholeWord: request.wholeWord, context: request.context, maxResults: request.maxResults, totalMatches, truncated: totalMatches > all.length, matches: Object.freeze(all), authority: 'extracted-text-only-v1' });
}
export const searchPdfExtractedText = searchPdfAdvancedText;
