export const DEFAULT_COMPARISON_LIMITS = Object.freeze({
  maxPages: 200,
  maxPairs: 8,
  maxTokensPerPage: 20_000,
  maxPixelsPerPage: 4_194_304,
  maxDifferenceImageBytes: 8 * 1024 * 1024,
  deadlineMs: 2 * 60_000,
});
