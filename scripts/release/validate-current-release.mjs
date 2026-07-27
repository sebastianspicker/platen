#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_FILES } from '../verify-required-files.mjs';
import { analyzeCurrentSourceReachability } from '../source-module-reachability.mjs';
import {
  DEFAULT_RELEASE_LIMITS,
  LOCAL_RELEASE_POLICY_SCHEMA,
  validateLocalRelease,
} from './local-release-validator.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const CURRENT_LOCAL_RELEASE_POLICY = Object.freeze({
  schema: LOCAL_RELEASE_POLICY_SCHEMA,
  requiredPaths: Object.freeze([
    'package.json',
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'CHANGELOG.md',
    'RELEASE_STATUS.md',
    'docs/RELEASING.md',
    'docs/releases/0.3.0-alpha.1.md',
    'docs/screenshots/README.md',
    'docs/screenshots/manifest.json',
    ...REQUIRED_FILES,
  ]),
  package: Object.freeze({
    name: 'platen',
    version: '0.3.0-alpha.1',
    nodeEngine: '>=20',
    license: 'MIT',
    private: true,
  }),
  limits: Object.freeze({
    ...DEFAULT_RELEASE_LIMITS,
    maxFiles: 2_048,
  }),
});

export async function validateCurrentLocalRelease(root = repositoryRoot) {
  const receipt = await validateLocalRelease({ root, policy: CURRENT_LOCAL_RELEASE_POLICY });
  const reachability = analyzeCurrentSourceReachability(root, REQUIRED_FILES);
  const failed = [
    ...reachability.unresolvedImports,
    ...reachability.unexpectedUnreachable,
    ...reachability.staleUnshipped,
    ...reachability.missingFromInventory,
  ].length > 0;
  const reachabilityCheck = Object.freeze({
    name: 'production-module-reachability',
    status: failed ? 'fail' : 'pass',
    code: failed ? 'RELEASE_SOURCE_REACHABILITY_FAILED' : null,
  });
  return Object.freeze({
    ...receipt,
    status: receipt.status === 'fail' || failed ? 'fail' : 'pass',
    checks: Object.freeze([...receipt.checks, reachabilityCheck]),
    sourceInventory: Object.freeze({
      reachableModules: reachability.reachable.length,
      nativeSourceFiles: reachability.nativeSources.length,
      intentionallyUnshippedModules: reachability.intentionallyUnshipped.length,
    }),
  });
}

async function main() {
  if (process.argv.length !== 2) {
    process.stderr.write(`${JSON.stringify({
      error: {
        code: 'RELEASE_ARGUMENTS_UNSUPPORTED',
        message: 'The local release validator does not accept paths or policy overrides.',
      },
    })}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const receipt = await validateCurrentLocalRelease();
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.status !== 'pass') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: {
        code: typeof error?.code === 'string' ? error.code : 'RELEASE_VALIDATION_FAILED',
        message: error?.message ?? 'Local release validation failed.',
      },
    })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
