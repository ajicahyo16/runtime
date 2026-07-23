export function compareAuthoringState({ baseFingerprint, repositoryFingerprint, controlPlaneFingerprint }) {
  if (!baseFingerprint) {
    if (repositoryFingerprint === controlPlaneFingerprint) return { status: 'converged', canApply: true, canPull: true }
    return { status: 'unbased', canApply: false, canPull: false, guidance: 'Pull or explicitly adopt one source before applying.' }
  }
  const repositoryChanged = repositoryFingerprint !== baseFingerprint
  const controlPlaneChanged = controlPlaneFingerprint !== baseFingerprint
  if (!repositoryChanged && !controlPlaneChanged) return { status: 'clean', canApply: true, canPull: true }
  if (repositoryChanged && !controlPlaneChanged) return { status: 'repository-changed', canApply: true, canPull: false }
  if (!repositoryChanged && controlPlaneChanged) return { status: 'control-plane-changed', canApply: false, canPull: true }
  if (repositoryFingerprint === controlPlaneFingerprint) return { status: 'converged', canApply: true, canPull: true }
  return {
    status: 'conflict',
    canApply: false,
    canPull: false,
    guidance: 'Export the Control Plane version, compare it with repository files, and create an explicit merged revision.',
  }
}

export function compareEnvironmentState({ expectedRevision, deployedRevision, expectedFingerprint, deployedFingerprint }) {
  if (!deployedRevision) return { status: 'not-deployed' }
  if (expectedRevision === deployedRevision && expectedFingerprint === deployedFingerprint) return { status: 'clean' }
  return {
    status: 'environment-drift',
    revisionChanged: expectedRevision !== deployedRevision,
    fingerprintChanged: expectedFingerprint !== deployedFingerprint,
  }
}

export function createLock({ projectFingerprint, baseRevision, controlPlaneFingerprint = projectFingerprint, environments = {} }) {
  return {
    version: 1,
    authoring: { baseFingerprint: projectFingerprint, controlPlaneFingerprint },
    projectFingerprint,
    baseRevision,
    environments,
  }
}

export function fileManagedProjectSummary({ projectId, fingerprint, baseRevision, source = 'repository' }) {
  if (!['repository', 'visual'].includes(source)) throw new Error('Project source must be repository or visual.')
  return { projectId, source, fileManaged: source === 'repository', fingerprint, baseRevision }
}
