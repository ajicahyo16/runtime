import { useEffect, useState } from 'react'
import { CheckCircle2, CircleDot, CloudCog, ExternalLink, FileCode2, History, Info, Loader2, LockKeyhole, Rocket, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ReleaseSummary {
  id: string
  checksum: string
  status: string
  createdAt: number
  manifest: { contracts?: unknown[] }
  approved?: boolean
}

type DeploymentEnvironment = 'dev' | 'staging' | 'production'

interface Deployment {
  id: string
  environment: DeploymentEnvironment
  status: 'planned' | 'provisioning' | 'deploying' | 'succeeded' | 'failed' | 'rolled_back'
  runtime_url?: string | null
  runtimeUrl?: string | null
  updated_at?: number
  updatedAt?: number
  smokeCheck?: { status: string; message: string } | null
}

export function DeployView({ project }: { project: string }) {
  const [releases, setReleases] = useState<ReleaseSummary[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [isCompiling, setIsCompiling] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busyRelease, setBusyRelease] = useState<string | null>(null)
  const [deploymentJobs, setDeploymentJobs] = useState<Record<string, Partial<Record<DeploymentEnvironment, Deployment>>>>({})

  useEffect(() => {
    let active = true
    fetch(`/api/projects/${encodeURIComponent(project)}/releases`)
      .then(async (response) => ({ response, data: await response.json().catch(() => null) }))
      .then(({ response, data }) => {
        if (!active || !response.ok || !data?.success) return
        setReleases(data.releases)
        void Promise.all(data.releases.map(async (release: ReleaseSummary) => {
          const result = await fetch(`/api/projects/${encodeURIComponent(project)}/releases/${release.id}/deployments`)
          const jobs = await result.json().catch(() => null)
          const byEnvironment = Object.fromEntries((jobs?.deployments || []).map((job: Deployment) => [job.environment, job]))
          return [release.id, byEnvironment] as const
        })).then((items) => {
          if (active) setDeploymentJobs(Object.fromEntries(items))
        }).catch(() => undefined)
        setIsConnected(true)
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [project])

  async function compileRelease() {
    setIsCompiling(true)
    setMessage(null)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/releases`, { method: 'POST' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.message || 'Release could not be compiled.')
      setReleases((current) => [data.release, ...current.filter((release) => release.id !== data.release.id)])
      setMessage(data.reused ? 'The current contracts already match an existing immutable release.' : 'Immutable release compiled successfully.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Release could not be compiled.')
    } finally {
      setIsCompiling(false)
    }
  }

  async function governRelease(release: ReleaseSummary, operation: 'verify' | 'approve') {
    setBusyRelease(`${release.id}:${operation}`); setMessage(null)
    try {
      if (operation === 'approve') {
        const summary = window.prompt('Describe the Production change and verification evidence (minimum 10 characters):')
        if (!summary) throw new Error('Production approval requires a reviewed change summary.')
        const rollbackReleaseId = releases.find((candidate) => candidate.id !== release.id && deploymentJobs[candidate.id]?.production?.status === 'succeeded')?.id
        const changeResponse = await fetch(`/api/projects/${encodeURIComponent(project)}/releases/${release.id}/change-request`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary, rollbackReleaseId }),
        })
        const changeData = await changeResponse.json().catch(() => null)
        if (!changeResponse.ok || !changeData?.success) throw new Error(changeData?.message || 'Production change request could not be created.')
        const reviewResponse = await fetch(`/api/projects/${encodeURIComponent(project)}/releases/${release.id}/change-request/approve`, { method: 'POST' })
        const reviewData = await reviewResponse.json().catch(() => null)
        if (!reviewResponse.ok || !reviewData?.success) throw new Error(reviewData?.message || 'Production change request could not be approved.')
      }
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/releases/${release.id}/${operation}`, { method: 'POST' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.message || `Release could not be ${operation === 'verify' ? 'verified' : 'approved'}.`)
      setReleases((current) => current.map((item) => item.id === release.id ? { ...item, status: data.releaseStatus || item.status, approved: operation === 'approve' ? true : item.approved } : item))
      setMessage(operation === 'verify' ? (data.verification.status === 'passed' ? 'Verification passed. The release is ready for Development.' : 'Verification failed. Review the artifact checks.') : 'Reviewed change request and configuration-bound approval recorded. Production promotion is unlocked.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Release workflow failed.') } finally { setBusyRelease(null) }
  }

  async function deployEnvironment(release: ReleaseSummary, environment: DeploymentEnvironment) {
    const label = environment === 'dev' ? 'Development' : environment === 'staging' ? 'Staging' : 'Production'
    setBusyRelease(`${release.id}:${environment}`); setMessage(null)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/releases/${release.id}/deployments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ environment }) })
      const data = await response.json().catch(() => null)
      if (data?.deployment) setDeploymentJobs((current) => ({ ...current, [release.id]: { ...current[release.id], [environment]: data.deployment } }))
      if (!response.ok || !data?.success) throw new Error(data?.message || `${label} deployment preflight failed.`)
      setMessage(data.reused ? `${label} job is ${data.deployment.status}.` : data.deployment.status === 'succeeded' ? `${label} succeeded. Runtime: ${data.deployment.runtimeUrl}` : data.deployment.smokeCheck?.message || `${label} deployment failed.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : `${label} deployment preflight failed.`) } finally { setBusyRelease(null) }
  }

  function environmentButton(release: ReleaseSummary, environment: DeploymentEnvironment, job?: Deployment) {
    const label = environment === 'dev' ? 'Development' : environment === 'staging' ? 'Staging' : 'Production'
    const busy = busyRelease === `${release.id}:${environment}`
    if (!job) return <Button size="default" disabled={busyRelease !== null} onClick={() => deployEnvironment(release, environment)}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}{environment === 'dev' ? 'Deploy to Development' : `Promote to ${label}`}</Button>
    if (job.status === 'planned' || job.status === 'failed' || job.status === 'rolled_back') return <Button size="default" disabled={busyRelease !== null} onClick={() => deployEnvironment(release, environment)}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}{job.status === 'planned' ? `Run ${label}` : `Retry ${label}`}</Button>
    if (job.status === 'provisioning' || job.status === 'deploying') {
      const updated = job.updatedAt || job.updated_at || Date.now()
      if (Date.now() - updated > 5 * 60 * 1000) return <Button size="default" disabled={busyRelease !== null} onClick={() => deployEnvironment(release, environment)}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}Retry {label}</Button>
      return <Button size="default" variant="outline" disabled><Loader2 className="size-3.5 animate-spin" />{label} running</Button>
    }
    const runtimeUrl = job.runtimeUrl || job.runtime_url
    return runtimeUrl ? <Button size="default" variant="outline" asChild><a href={runtimeUrl} target="_blank" rel="noreferrer">Open {label}<ExternalLink className="size-3.5" /></a></Button> : null
  }

  function releaseCta(release: ReleaseSummary) {
    const jobs = deploymentJobs[release.id] || {}
    if (release.status === 'compiled') return <Button size="default" disabled={busyRelease !== null} onClick={() => governRelease(release, 'verify')}>{busyRelease === `${release.id}:verify` ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}Verify release</Button>
    if (release.status !== 'verified') return null
    if (jobs.dev?.status !== 'succeeded') return environmentButton(release, 'dev', jobs.dev)
    if (jobs.staging?.status !== 'succeeded') return environmentButton(release, 'staging', jobs.staging)
    if (!release.approved) return <Button size="default" disabled={busyRelease !== null} onClick={() => governRelease(release, 'approve')}>{busyRelease === `${release.id}:approve` ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}Approve Production</Button>
    return environmentButton(release, 'production', jobs.production)
  }

  const currentRelease = releases[0]
  const currentJobs = currentRelease ? deploymentJobs[currentRelease.id] || {} : {}
  const developmentSucceeded = currentJobs.dev?.status === 'succeeded'
  const stagingSucceeded = currentJobs.staging?.status === 'succeeded'
  const productionSucceeded = currentJobs.production?.status === 'succeeded'
  const currentJob = currentJobs.production || currentJobs.staging || currentJobs.dev
  const releaseHistory = releases.slice(1)
  const messageIsError = Boolean(message && /failed|error|rejected|could not/i.test(message))

  function deploymentLabel(job?: Deployment) {
    if (!job) return 'Not deployed'
    if (job.status === 'provisioning') return 'Preparing'
    if (job.status === 'deploying') return 'Deploying'
    if (job.status === 'succeeded') return 'Healthy'
    if (job.status === 'failed') return 'Failed'
    if (job.status === 'rolled_back') return 'Rolled back'
    return 'Planned'
  }

  function environmentName(environment?: DeploymentEnvironment) {
    if (environment === 'dev') return 'Development'
    if (environment === 'staging') return 'Staging'
    if (environment === 'production') return 'Production'
    return 'No environment'
  }

  function nextActionCopy(release: ReleaseSummary, jobs: Partial<Record<DeploymentEnvironment, Deployment>>) {
    if (release.status === 'compiled') return 'Run artifact checks before this release can be deployed.'
    if (release.status !== 'verified') return 'Resolve verification checks before continuing.'
    const activeJob = jobs.production || jobs.staging || jobs.dev
    if (activeJob?.status === 'failed' || activeJob?.status === 'rolled_back') return `The ${environmentName(activeJob.environment)} attempt did not complete. Retry the same immutable artifact.`
    if (activeJob?.status === 'provisioning' || activeJob?.status === 'deploying') return `Cloudflare is preparing ${environmentName(activeJob.environment)}. Actions are temporarily locked.`
    if (jobs.dev?.status !== 'succeeded') return 'Deploy this verified release to the isolated Development environment.'
    if (jobs.staging?.status !== 'succeeded') return 'Development is healthy. Promote the exact artifact to Staging.'
    if (!release.approved) return 'Staging is healthy. Owner approval is required before Production.'
    if (jobs.production?.status !== 'succeeded') return 'Approval is recorded. Promote the exact Staging artifact to Production.'
    return 'Production is healthy. This release has completed its promotion path.'
  }

  return (
    <section className="glass-card workspace-panel deploy-view">
      <div className="workspace-panel__header">
        <div className="workspace-panel__title">
          <div className="flex items-center gap-2 mb-1.5"><span className="section-icon"><CloudCog className="size-4" /></span><h2 className="text-xl font-bold tracking-tight">Releases</h2></div>
          <p className="text-xs text-muted-foreground">Compile an immutable snapshot of <span className="font-mono text-foreground">{project}</span> before it can enter an environment.</p>
        </div>
        {isConnected && <Button size="sm" onClick={compileRelease} disabled={isCompiling}>{isCompiling ? <Loader2 className="size-3.5 animate-spin" /> : <FileCode2 className="size-3.5" />}{isCompiling ? 'Compiling…' : 'Compile release'}</Button>}
      </div>

      {!isConnected ? <p className="deploy-view__notice" role="status"><Info className="size-4" /> Connect the deployed Control API to compile releases. Local Vite mode does not create immutable release artifacts.</p> : <>
        {message && <p className={`release-message${messageIsError ? ' is-error' : ''}`} role="status">{messageIsError ? <TriangleAlert className="size-4" /> : <CheckCircle2 className="size-4" />}{message}</p>}

        {currentRelease ? <article className="current-release" aria-label="Current release">
          <div className="current-release__topline">
            <div>
              <span className="release-eyebrow">Current release</span>
              <h3>{currentRelease.id}</h3>
              <p>Created {new Date(currentRelease.createdAt).toLocaleString()}</p>
            </div>
            <span className={`release-badge release-badge--${currentRelease.status}`}>{currentRelease.status}</span>
          </div>

          <dl className="current-release__facts">
            <div><dt>Contracts</dt><dd>{currentRelease.manifest.contracts?.length || 0}</dd></div>
            <div><dt>Artifact</dt><dd><code title={currentRelease.checksum}>{currentRelease.checksum.slice(0, 12)}</code></dd></div>
            <div><dt>Latest environment</dt><dd className={`deployment-state deployment-state--${currentJob?.status || 'idle'}`}>{currentJob?.status === 'succeeded' && <CheckCircle2 className="size-3.5" />}{environmentName(currentJob?.environment)} · {deploymentLabel(currentJob)}</dd></div>
          </dl>

          {currentJob?.smokeCheck && <div className={`smoke-result smoke-result--${currentJob.smokeCheck.status}`}>
            {currentJob.smokeCheck.status === 'passed' ? <CheckCircle2 className="size-4" /> : <TriangleAlert className="size-4" />}
            <div><strong>Smoke check {currentJob.smokeCheck.status}</strong><span>{currentJob.smokeCheck.message}</span></div>
          </div>}

          <div className="current-release__footer">
            <div><span>Next action</span><p>{nextActionCopy(currentRelease, currentJobs)}</p></div>
            <div className="current-release__action">{releaseCta(currentRelease)}</div>
          </div>
        </article> : <div className="release-empty"><FileCode2 className="size-5" /><div><strong>No releases yet</strong><p>Compile the validated contracts to create an immutable artifact.</p></div></div>}

        <section className="promotion-section" aria-label="Environment promotion status">
          <div className="release-section-heading"><div><span className="release-eyebrow">Promotion path</span><h3>Environments</h3></div><p>The same immutable artifact moves forward; it is never rebuilt between environments.</p></div>
          <ol className="promotion-flow">
            <li className={developmentSucceeded ? 'is-complete' : 'is-current'}><span className="promotion-flow__icon">{developmentSucceeded ? <CheckCircle2 /> : <CircleDot />}</span><div><span>01</span><strong>Development</strong><small>{developmentSucceeded ? 'Smoke checks passed' : 'Verify and deploy'}</small></div></li>
            <li className={stagingSucceeded ? 'is-complete' : developmentSucceeded ? 'is-current' : 'is-locked'}><span className="promotion-flow__icon">{stagingSucceeded ? <CheckCircle2 /> : developmentSucceeded ? <CircleDot /> : <LockKeyhole />}</span><div><span>02</span><strong>Staging</strong><small>{stagingSucceeded ? 'Smoke checks passed' : developmentSucceeded ? 'Ready to promote' : 'Requires Development'}</small></div></li>
            <li className={productionSucceeded ? 'is-complete' : stagingSucceeded ? 'is-current' : 'is-locked'}><span className="promotion-flow__icon">{productionSucceeded ? <CheckCircle2 /> : stagingSucceeded ? <CircleDot /> : <LockKeyhole />}</span><div><span>03</span><strong>Production</strong><small>{productionSucceeded ? 'Live and healthy' : stagingSucceeded ? currentRelease?.approved ? 'Ready to promote' : 'Approval required' : 'Requires Staging'}</small></div></li>
          </ol>
        </section>

        {releaseHistory.length > 0 && <details className="release-history">
          <summary><span><History className="size-4" /><span><strong>Release history</strong><small>{releaseHistory.length} previous immutable {releaseHistory.length === 1 ? 'release' : 'releases'}</small></span></span><span>Show history</span></summary>
          <div className="release-history__list">
            {releaseHistory.map((release) => { const jobs = deploymentJobs[release.id] || {}; const job = jobs.production || jobs.staging || jobs.dev; const runtimeUrl = job?.runtimeUrl || job?.runtime_url; return <div className="release-history__item" key={release.id}>
              <div><strong>{release.id}</strong><span>{new Date(release.createdAt).toLocaleString()} · {release.manifest.contracts?.length || 0} contracts</span></div>
              <div><span className={`history-state history-state--${job?.status || release.status}`}>{deploymentLabel(job)}</span><code title={release.checksum}>{release.checksum.slice(0, 12)}</code>{runtimeUrl && <a href={runtimeUrl} target="_blank" rel="noreferrer" aria-label={`Open runtime for ${release.id}`}><ExternalLink className="size-3.5" /></a>}</div>
            </div> })}
          </div>
        </details>}
      </>}
    </section>
  )
}
