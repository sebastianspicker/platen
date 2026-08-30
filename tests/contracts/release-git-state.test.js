import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCandidateGitState } from '../../tools/release/validate-current-release.mjs';

test('release candidate git-state assessment distinguishes clean, dirty, and unavailable snapshots', () => {
  const clean = assessCandidateGitState('/fixture', () => ({ status: 0, stdout: '', error: null }));
  assert.deepEqual(clean, { name: 'git-candidate-state', status: 'pass', code: null });

  const dirty = assessCandidateGitState('/fixture', () => ({ status: 0, stdout: ' M src/host/example.mjs\n', error: null }));
  assert.deepEqual(dirty, {
    name: 'git-candidate-state', status: 'fail', code: 'RELEASE_GIT_WORKTREE_DIRTY',
  });

  for (const result of [
    { status: 1, stdout: '', error: null },
    { status: null, stdout: '', error: new Error('git unavailable') },
  ]) {
    assert.deepEqual(assessCandidateGitState('/fixture', () => result), {
      name: 'git-candidate-state', status: 'fail', code: 'RELEASE_GIT_STATE_UNAVAILABLE',
    });
  }
});
