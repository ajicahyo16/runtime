import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareAuthoringState, compareEnvironmentState, createLock, fileManagedProjectSummary } from '../src/synchronization.mjs'

test('three-way authoring comparison detects clean, one-sided, converged, and conflict states', () => {
  assert.equal(compareAuthoringState({ baseFingerprint: 'a', repositoryFingerprint: 'a', controlPlaneFingerprint: 'a' }).status, 'clean')
  assert.equal(compareAuthoringState({ baseFingerprint: 'a', repositoryFingerprint: 'b', controlPlaneFingerprint: 'a' }).status, 'repository-changed')
  assert.equal(compareAuthoringState({ baseFingerprint: 'a', repositoryFingerprint: 'a', controlPlaneFingerprint: 'b' }).status, 'control-plane-changed')
  assert.equal(compareAuthoringState({ baseFingerprint: 'a', repositoryFingerprint: 'b', controlPlaneFingerprint: 'b' }).status, 'converged')
  const conflict = compareAuthoringState({ baseFingerprint: 'a', repositoryFingerprint: 'b', controlPlaneFingerprint: 'c' })
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.canApply, false)
  assert.equal(conflict.canPull, false)
})

test('environment drift remains separate from authoring drift', () => {
  assert.equal(compareEnvironmentState({ expectedRevision: 'r1', deployedRevision: 'r2', expectedFingerprint: 'a', deployedFingerprint: 'a' }).status, 'environment-drift')
  assert.equal(compareEnvironmentState({ expectedRevision: 'r1', deployedRevision: 'r1', expectedFingerprint: 'a', deployedFingerprint: 'a' }).status, 'clean')
})

test('lock and project summary preserve file-managed identity', () => {
  const lock = createLock({ projectFingerprint: 'abc', baseRevision: 'revision-1' })
  assert.equal(lock.authoring.baseFingerprint, 'abc')
  assert.equal(fileManagedProjectSummary({ projectId: 'pos', fingerprint: 'abc', baseRevision: 'revision-1' }).fileManaged, true)
  assert.equal(fileManagedProjectSummary({ projectId: 'pos', fingerprint: 'abc', baseRevision: 'revision-1', source: 'visual' }).fileManaged, false)
})
