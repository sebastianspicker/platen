#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseArtifactPaths } from '../../tools/verify/release-artifact-manifest.mjs';
import {
  analyzeCurrentSourceReachability,
  collectProductionSourcePaths,
} from '../../tools/analysis/source-module-reachability.mjs';
import {
  DEFAULT_RELEASE_LIMITS,
  LOCAL_RELEASE_POLICY_SCHEMA,
  validateLocalRelease,
} from './local-release-validator.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function currentLocalReleasePolicy(root = repositoryRoot) {
  const requiredPaths = Object.freeze([
    ...collectReleaseArtifactPaths(root),
    ...collectProductionSourcePaths(root),
  ].sort());
  return Object.freeze({
  schema: LOCAL_RELEASE_POLICY_SCHEMA,
  requiredPaths,
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
}

export function assessCandidateGitState(root, spawn = spawnSync) {
  const result = spawn('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    return Object.freeze({
      name: 'git-candidate-state',
      status: 'fail',
      code: 'RELEASE_GIT_STATE_UNAVAILABLE',
    });
  }
  if (result.stdout.length !== 0) {
    return Object.freeze({
      name: 'git-candidate-state',
      status: 'fail',
      code: 'RELEASE_GIT_WORKTREE_DIRTY',
    });
  }
  return Object.freeze({ name: 'git-candidate-state', status: 'pass', code: null });
}

export async function validateCurrentLocalRelease(root = repositoryRoot) {
  const receipt = await validateLocalRelease({ root, policy: currentLocalReleasePolicy(root) });
  const gitStateCheck = assessCandidateGitState(root);
  const reachability = analyzeCurrentSourceReachability(root);
  const failed = [
    ...reachability.missingEntrypoints,
    ...reachability.unresolvedImports,
    ...reachability.unexpectedUnreachable,
    ...reachability.staleUnshipped,
  ].length > 0;
  const reachabilityCheck = Object.freeze({
    name: 'production-module-reachability',
    status: failed ? 'fail' : 'pass',
    code: failed ? 'RELEASE_SOURCE_REACHABILITY_FAILED' : null,
  });
  return Object.freeze({
    ...receipt,
    status: receipt.status === 'fail' || failed || gitStateCheck.status === 'fail' ? 'fail' : 'pass',
    checks: Object.freeze([...receipt.checks, reachabilityCheck, gitStateCheck]),
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
