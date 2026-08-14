#!/usr/bin/env node
/**
 * Fail if any normalized professional-capability handler body appears ≥3 times.
 * Scans both:
 *   - async 'capability.id'(ctx = {}) { ... } registry wrappers
 *   - export function name(ctx = {}) { ... } named domain functions
 * Prevents rename-theater clones from satisfying the bulk evidence suite.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'scripts/host/professional-capability');

// async 'id'(ctx = {}) { body }
const ASYNC_HANDLER_RE = /async\s+'([^']+)'\s*\(\s*ctx\s*=\s*\{\}\s*\)\s*\{([\s\S]*?)\n  \}/g;
// export function name(ctx = {}) { body }  OR  export async function name(ctx = {}) { body }
const EXPORT_FN_RE = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(\s*ctx\s*=\s*\{\}\s*\)\s*\{([\s\S]*?)\n\}/g;

export function extractHandlerBodies(source, fileName) {
  const found = [];
  let match;
  const asyncRe = new RegExp(ASYNC_HANDLER_RE.source, 'g');
  while ((match = asyncRe.exec(source)) !== null) {
    found.push({ id: match[1], body: match[2], file: fileName, kind: 'async-handler' });
  }
  const exportRe = new RegExp(EXPORT_FN_RE.source, 'g');
  while ((match = exportRe.exec(source)) !== null) {
    found.push({ id: match[1], body: match[2], file: fileName, kind: 'export-function' });
  }
  return found;
}

export function normalizeHandlerBody(body) {
  let norm = String(body);
  // Strip string literals (including capability ids and op names)
  norm = norm.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, "''");
  // Strip comments
  norm = norm.replace(/\/\*[\s\S]*?\*\//g, ' ');
  norm = norm.replace(/\/\/[^\n]*/g, ' ');
  // Collapse whitespace
  norm = norm.replace(/\s+/g, ' ').trim();
  return norm;
}

export function hashBody(normalized) {
  return createHash('sha256').update(normalized).digest('hex');
}

export function findHandlerClones({ directory = dir, minCopies = 3 } = {}) {
  const files = readdirSync(directory).filter((name) => name.endsWith('.mjs'));
  const byHash = new Map();
  for (const name of files) {
    const source = readFileSync(join(directory, name), 'utf8');
    for (const handler of extractHandlerBodies(source, name)) {
      const normalized = normalizeHandlerBody(handler.body);
      // Ignore trivial one-liner re-exports: return someNamedFn(ctx);
      if (!normalized || normalized.length < 24) continue;
      if (/^return [A-Za-z0-9_]+\(ctx\);?$/.test(normalized)) continue;
      const digest = hashBody(normalized);
      if (!byHash.has(digest)) byHash.set(digest, []);
      byHash.get(digest).push({ ...handler, normalized, digest });
    }
  }
  return [...byHash.entries()]
    .filter(([, group]) => group.length >= minCopies)
    .map(([digest, group]) => ({
      digest,
      count: group.length,
      ids: group.map((item) => item.id),
      kinds: [...new Set(group.map((item) => item.kind))],
      files: [...new Set(group.map((item) => item.file))],
      sample: group[0].normalized.slice(0, 160),
    }))
    .sort((a, b) => b.count - a.count || a.digest.localeCompare(b.digest));
}

export function assertNoHandlerClones(options) {
  const clones = findHandlerClones(options);
  if (clones.length) {
    const detail = clones
      .map((clone) => `- ${clone.count}× ${clone.digest.slice(0, 12)} in ${clone.files.join(',')} [${clone.kinds.join('|')}]: ${clone.ids.slice(0, 8).join(', ')}${clone.ids.length > 8 ? '…' : ''}`)
      .join('\n');
    const error = new Error(`Professional handler clone bodies detected (≥3 identical normalized bodies):\n${detail}`);
    error.code = 'PROFESSIONAL_HANDLER_CLONES';
    error.clones = clones;
    throw error;
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-professional-handler-clones.mjs')) {
  try {
    assertNoHandlerClones();
    process.stdout.write('No professional-capability handler clones (≥3) detected.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
