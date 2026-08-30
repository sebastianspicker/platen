import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCE_ROOT = resolve(repositoryRoot, 'src');
const CONTRACTS_ROOT = resolve(SOURCE_ROOT, 'contracts');
const PUBLIC_IDENTIFIER = '(?:[A-Z][A-Z0-9_]*_)?(?:PROFILE|MEDIA_TYPE|SCHEMA_VERSION|VERSION|KIND)';
const DECLARED_LITERAL = new RegExp(
  `^(?:export\\s+)?(?:const|let|var)\\s+(${PUBLIC_IDENTIFIER})\\s*=\\s*(?:'([^'\\n]+)'|\"([^\"\\n]+)\"|(\\d+))\\s*;`,
  'gmu',
);
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;/gu;
const IMPORTED_PUBLIC_IDENTIFIER = new RegExp(`\\b(${PUBLIC_IDENTIFIER})\\b`, 'gu');
const INLINE_PUBLIC_WIRE_PROPERTY = /\b(profile|mediaType|contentType|kind|schemaVersion|version)\s*:\s*(?:'([^'\n]+)'|"([^"\n]+)"|(\d+))/gu;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:js|mjs)$/u.test(entry.name) ? [path] : [];
  });
}

function productionArea(path) {
  const parts = relative(SOURCE_ROOT, path).split('/');
  if (parts[0] !== 'host') return parts[0];
  return parts[1] && ['application', 'platform', 'transport'].includes(parts[1])
    ? `host/${parts[1]}`
    : 'host/root';
}

function declaredPublicLiterals(path, source = readFileSync(path, 'utf8'), area = productionArea(path)) {
  return [...source.matchAll(new RegExp(DECLARED_LITERAL.source, DECLARED_LITERAL.flags))].map((match) => Object.freeze({
    path: relative(repositoryRoot, path),
    area,
    name: match[1],
    value: match[2] ?? match[3] ?? Number(match[4]),
  }));
}

function productionPublicLiterals() {
  return sourceFiles(SOURCE_ROOT)
    .filter((path) => !path.startsWith(`${CONTRACTS_ROOT}/`))
    .flatMap((path) => declaredPublicLiterals(path));
}

function neutralAuthorities() {
  return sourceFiles(CONTRACTS_ROOT)
    .flatMap((path) => declaredPublicLiterals(path, readFileSync(path, 'utf8'), 'contracts'));
}

function namedHostPublicIdentifierImports(path, source = readFileSync(path, 'utf8')) {
  const violations = [];
  for (const match of source.matchAll(new RegExp(NAMED_IMPORT.source, NAMED_IMPORT.flags))) {
    if (!/(?:^|\/)host\/(?:application|platform)(?:\/|$)/u.test(match[2])) continue;
    for (const identifier of match[1].matchAll(new RegExp(IMPORTED_PUBLIC_IDENTIFIER.source, IMPORTED_PUBLIC_IDENTIFIER.flags))) {
      violations.push(`${relative(repositoryRoot, path)} imports ${identifier[1]} from ${match[2]}; public wire identifiers must come from src/contracts`);
    }
  }
  return violations;
}

function inlinePublicWireLiterals(path, source, neutral) {
  const neutralByValue = Map.groupBy(neutral, ({ value }) => String(value));
  return [...source.matchAll(new RegExp(INLINE_PUBLIC_WIRE_PROPERTY.source, INLINE_PUBLIC_WIRE_PROPERTY.flags))].flatMap((match) => {
    const value = match[2] ?? match[3] ?? Number(match[4]);
    const authorities = neutralByValue.get(String(value)) ?? [];
    if (authorities.length === 0) return [];
    return [`${relative(repositoryRoot, path)}:${match[1]} inlines ${JSON.stringify(value)} instead of ${authorities.map(({ path: authorityPath, name }) => `${authorityPath}:${name}`).join(', ')}`];
  });
}

function contextualNumericAuthorities(source, neutral) {
  const neutralByName = new Map(neutral.map((authority) => [authority.name, authority]));
  const imported = [];
  for (const match of source.matchAll(new RegExp(NAMED_IMPORT.source, NAMED_IMPORT.flags))) {
    for (const identifier of match[1].matchAll(new RegExp(IMPORTED_PUBLIC_IDENTIFIER.source, IMPORTED_PUBLIC_IDENTIFIER.flags))) {
      const authority = neutralByName.get(identifier[1]);
      if (authority && typeof authority.value === 'number') imported.push(authority);
    }
  }
  return imported;
}

function evasionViolations() {
  const neutral = neutralAuthorities();
  const stringAuthorities = neutral.filter(({ value }) => typeof value === 'string');
  return sourceFiles(SOURCE_ROOT)
    .filter((path) => !path.startsWith(`${CONTRACTS_ROOT}/`))
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [
        ...(['browser', 'cli'].includes(productionArea(path)) ? namedHostPublicIdentifierImports(path, source) : []),
        ...inlinePublicWireLiterals(path, source, [...stringAuthorities, ...contextualNumericAuthorities(source, neutral)]),
      ];
    })
    .sort();
}

function ownershipViolations(production, neutral) {
  // Numeric versions such as `1` are intentionally not global authorities:
  // unrelated versioned records commonly use that value. String wire spellings
  // remain globally identifiable, while direct named imports are checked below.
  const neutralByValue = Map.groupBy(neutral.filter(({ value }) => typeof value === 'string'), ({ value }) => String(value));
  const productionByValue = Map.groupBy(production.filter(({ value }) => typeof value === 'string'), ({ value }) => String(value));
  const violations = [];

  for (const [value, entries] of productionByValue) {
    const authorities = neutralByValue.get(value) ?? [];
    if (authorities.length > 0) {
      for (const entry of entries) {
        violations.push(`${entry.path}:${entry.name} duplicates neutral authority ${authorities.map(({ path, name }) => `${path}:${name}`).join(', ')}`);
      }
      continue;
    }

    const areas = new Set(entries.map(({ area }) => area));
    if (areas.size > 1) {
      violations.push(`${[...areas].sort().join(', ')} declare ${value} without a src/contracts authority`);
    }
  }

  for (const [value, authorities] of neutralByValue) {
    if (authorities.length > 1) {
      violations.push(`src/contracts has ${authorities.length} literal authorities for ${value}: ${authorities.map(({ path, name }) => `${path}:${name}`).join(', ')}`);
    }
  }

  return violations.sort();
}

test('neutral contracts are the sole literal authority for cross-area public wire identifiers', () => {
  assert.deepEqual(
    ownershipViolations(productionPublicLiterals(), neutralAuthorities()),
    [],
    'Production areas may import or re-export neutral identifiers, but cannot declare their wire literals.',
  );
});

test('all source areas reject host-import and inline-property wire-identifier evasions', () => {
  assert.deepEqual(
    evasionViolations(),
    [],
    'Public wire identifiers must be imported from src/contracts rather than host layers or inline object-property literals.',
  );
});

test('browser and platform duplicate profile literals require a neutral authority', () => {
  const browser = declaredPublicLiterals(resolve(SOURCE_ROOT, 'browser/fixture.js'), "export const PROFILE = 'local-browser-platform-fixture-v1';", 'browser');
  const platform = declaredPublicLiterals(resolve(SOURCE_ROOT, 'host/platform/fixture.mjs'), "export const PROFILE = 'local-browser-platform-fixture-v1';", 'host/platform');

  assert.deepEqual(ownershipViolations([...browser, ...platform], []), [
    'browser, host/platform declare local-browser-platform-fixture-v1 without a src/contracts authority',
  ]);
});

test('browser and platform duplicate media-type literals cannot shadow a neutral authority', () => {
  const browser = declaredPublicLiterals(resolve(SOURCE_ROOT, 'browser/fixture.js'), "export const MEDIA_TYPE = 'application/vnd.platen.fixture+json';", 'browser');
  const platform = declaredPublicLiterals(resolve(SOURCE_ROOT, 'host/platform/fixture.mjs'), "export const MEDIA_TYPE = 'application/vnd.platen.fixture+json';", 'host/platform');
  const neutral = declaredPublicLiterals(resolve(CONTRACTS_ROOT, 'fixture.mjs'), "export const FIXTURE_MEDIA_TYPE = 'application/vnd.platen.fixture+json';", 'contracts');

  assert.deepEqual(ownershipViolations([...browser, ...platform], neutral), [
    'src/browser/fixture.js:MEDIA_TYPE duplicates neutral authority src/contracts/fixture.mjs:FIXTURE_MEDIA_TYPE',
    'src/host/platform/fixture.mjs:MEDIA_TYPE duplicates neutral authority src/contracts/fixture.mjs:FIXTURE_MEDIA_TYPE',
  ]);
});

test('named imports of host public identifiers are rejected even without a duplicate declaration', () => {
  const fixture = "import { INCREMENTAL_BATCH_LINK_PROFILE } from '../../host/application/pdf/pdf-incremental-batch-link-contract.mjs';";
  assert.deepEqual(namedHostPublicIdentifierImports(resolve(SOURCE_ROOT, 'cli/fixture.mjs'), fixture), [
    'src/cli/fixture.mjs imports INCREMENTAL_BATCH_LINK_PROFILE from ../../host/application/pdf/pdf-incremental-batch-link-contract.mjs; public wire identifiers must come from src/contracts',
  ]);
});

test('inline object-property wire literals are rejected even without a duplicate declaration', () => {
  const neutral = declaredPublicLiterals(
    resolve(CONTRACTS_ROOT, 'fixture.mjs'),
    "export const FIXTURE_PROFILE = 'local-inline-fixture-v1';",
    'contracts',
  );
  const fixture = "const request = { profile: 'local-inline-fixture-v1' };";
  assert.deepEqual(inlinePublicWireLiterals(resolve(SOURCE_ROOT, 'browser/fixture.js'), fixture, neutral), [
    'src/browser/fixture.js:profile inlines "local-inline-fixture-v1" instead of src/contracts/fixture.mjs:FIXTURE_PROFILE',
  ]);
});

test('inline numeric schema-version literals are rejected for a specific neutral authority', () => {
  const neutral = declaredPublicLiterals(
    resolve(CONTRACTS_ROOT, 'fixture.mjs'),
    'export const FIXTURE_SCHEMA_VERSION = 7;',
    'contracts',
  );
  const fixture = 'const request = { schemaVersion: 7 };';
  assert.deepEqual(inlinePublicWireLiterals(resolve(SOURCE_ROOT, 'cli/fixture.mjs'), fixture, neutral), [
    'src/cli/fixture.mjs:schemaVersion inlines 7 instead of src/contracts/fixture.mjs:FIXTURE_SCHEMA_VERSION',
  ]);
});

test('aggregate evasion scan associates imported numeric authorities with their feature', () => {
  const neutral = declaredPublicLiterals(
    resolve(CONTRACTS_ROOT, 'fixture.mjs'),
    'export const FIXTURE_SCHEMA_VERSION = 7;',
    'contracts',
  );
  const fixture = "import { FIXTURE_SCHEMA_VERSION } from '../../contracts/fixture.mjs';\nconst request = { schemaVersion: 7 };";
  assert.deepEqual(
    inlinePublicWireLiterals(
      resolve(SOURCE_ROOT, 'host/application/fixture.mjs'),
      fixture,
      contextualNumericAuthorities(fixture, neutral),
    ),
    ['src/host/application/fixture.mjs:schemaVersion inlines 7 instead of src/contracts/fixture.mjs:FIXTURE_SCHEMA_VERSION'],
  );
});
