import { HostError } from './host-error.mjs';
import { DEFAULT_COMPARISON_LIMITS } from './comparison-contract.mjs';
import { decodePng, encodeRgbaPng } from './raster-png-codec.mjs';

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function tokenize(text, maximum) {
  const tokens = String(text ?? '').match(/\S+/gu) ?? [];
  if (tokens.length > maximum) {
    fail(
      'TEXT_COMPARISON_LIMIT',
      `A page exceeds the ${maximum}-token comparison limit.`,
      422,
    );
  }
  return tokens;
}

export function diffTokens(
  before,
  after,
  maximumTokens = DEFAULT_COMPARISON_LIMITS.maxTokensPerPage,
) {
  const left = tokenize(before, maximumTokens);
  const right = tokenize(after, maximumTokens);
  const cells = (left.length + 1) * (right.length + 1);
  if (cells > 2_000_000) {
    fail(
      'TEXT_COMPARISON_LIMIT',
      'The page pair is too large for bounded exact text comparison.',
      422,
    );
  }
  const rows = Array.from(
    { length: left.length + 1 }, () => new Uint32Array(right.length + 1),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      rows[i][j] = left[i] === right[j]
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const runs = [];
  let i = 0;
  let j = 0;
  const add = (kind, token) => {
    const last = runs.at(-1);
    if (last?.kind === kind) last.tokens.push(token);
    else runs.push({ kind, tokens: [token] });
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      add('unchanged', left[i]);
      i += 1;
      j += 1;
    } else if (j < right.length
      && (i === left.length || rows[i][j + 1] >= rows[i + 1][j])) {
      add('added', right[j]);
      j += 1;
    } else {
      add('deleted', left[i]);
      i += 1;
    }
  }
  const count = (kind) => runs.filter((run) => run.kind === kind)
    .reduce((sum, run) => sum + run.tokens.length, 0);
  return Object.freeze({
    runs: Object.freeze(runs.map((run) => Object.freeze({
      kind: run.kind,
      text: run.tokens.join(' '),
      count: run.tokens.length,
    }))),
    stats: Object.freeze({
      added: count('added'), deleted: count('deleted'), unchanged: count('unchanged'),
    }),
  });
}

export function comparePixels(leftPng, rightPng, limits = DEFAULT_COMPARISON_LIMITS) {
  const left = decodePng(leftPng, limits.maxPixelsPerPage);
  const right = decodePng(rightPng, limits.maxPixelsPerPage);
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  const pixels = Buffer.alloc(width * height * 4);
  let changed = 0;
  let totalDelta = 0;
  let maximumDelta = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const leftOffset = (y * left.width + x) * 4;
      const rightOffset = (y * right.width + x) * 4;
      const outputOffset = (y * width + x) * 4;
      const delta = Math.max(...[0, 1, 2, 3].map(
        (channel) => Math.abs(
          left.pixels[leftOffset + channel] - right.pixels[rightOffset + channel],
        ),
      ));
      if (delta) changed += 1;
      totalDelta += delta;
      maximumDelta = Math.max(maximumDelta, delta);
      pixels[outputOffset] = delta ? 255 : 0;
      pixels[outputOffset + 1] = 0;
      pixels[outputOffset + 2] = 0;
      pixels[outputOffset + 3] = 255;
    }
  }
  const differencePng = encodeRgbaPng({ width, height, pixels });
  if (differencePng.length > limits.maxDifferenceImageBytes) {
    fail(
      'DIFFERENCE_IMAGE_LIMIT',
      'The difference image exceeds the local output limit.',
      413,
    );
  }
  return Object.freeze({
    width,
    height,
    left: { width: left.width, height: left.height },
    right: { width: right.width, height: right.height },
    changedPixels: changed,
    comparedPixels: width * height,
    dimensionMismatch: left.width !== right.width || left.height !== right.height,
    meanChannelDelta: width * height ? totalDelta / (width * height) : 0,
    maximumChannelDelta: maximumDelta,
    differencePng,
  });
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${stable(value[key])}`,
  ).join(',')}}`;
}

export function compareAnnotationSnapshots(left, right) {
  const leftById = new Map(left.map((item) => [item.id, item]));
  const rightById = new Map(right.map((item) => [item.id, item]));
  const added = [];
  const deleted = [];
  const changed = [];
  const unchanged = [];
  for (const [id, item] of rightById) {
    if (!leftById.has(id)) added.push(item);
    else if (stable(leftById.get(id)) === stable(item)) unchanged.push(id);
    else changed.push({ id, before: leftById.get(id), after: item });
  }
  for (const [id, item] of leftById) {
    if (!rightById.has(id)) deleted.push(item);
  }
  return { added, deleted, changed, unchanged };
}
