import { useEffect, useMemo, useState } from 'react'
import { Activity, AppWindow, Boxes, CheckCircle2, ChevronDown, Clock, CloudCog, Cpu, Database, ExternalLink, Gauge, GitBranch, Info, ListChecks, Search, Server, Timer, TriangleAlert } from 'lucide-react'
import type { Actor } from '@/components/ActorCard'
import { loadContracts } from '@/lib/contracts'

interface DeploymentOverview {
  id: string
  releaseId: string
  checksum?: string
  environment: 'dev' | 'staging' | 'production'
  status: string
  runtimeUrl?: string | null
  updatedAt: number
}

interface RuntimeEvent {
  objectId?: string | null
  action?: string | null
  level: string
  message: string
  occurredAt: number
}

interface EnvironmentHealth {
  environment: 'dev' | 'staging' | 'production'
  status: 'healthy' | 'degraded' | 'unhealthy' | 'deploying' | 'unknown'
  stale: boolean
  deployment: { id: string; releaseId: string; checksum: string; status: string; runtimeUrl?: string | null; updatedAt: number } | null
  layers: Array<{ layer: 'worker' | 'durable_object' | 'sqlite'; aggregateType?: string | null; status: 'healthy' | 'unhealthy'; latencyMs: number; message: string; checkedAt: number }>
  lastSuccessAt?: number | null
  lastFailure?: { message: string; layer: string; aggregateType?: string | null; occurredAt: number } | null
}

interface MetricSummary {
  requests: number
  successes: number
  errors: number
  errorRate: number | null
  averageLatencyMs: number | null
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  p99LatencyMs: number | null
}

interface CommandMetric extends MetricSummary {
  key: string
  aggregateType: string
  action: string
}

interface RuntimeMetrics {
  summary: MetricSummary
  commands: CommandMetric[]
  availability: { wallTime: 'observed'; cpuTime: 'unavailable'; percentiles: string }
}

interface OperationsOverview {
  storage: Array<{ aggregate_type: string; environment: string; storage_bytes: number; growthBytes: number | null; growthRate: number | null; thresholdBytes: number; warning: boolean; tableStats: Array<{ name: string; rows: number }>; checked_at: number }>
  partitions: Array<{ aggregate_type: string; partition_hash: string; requests: number; errors: number; average_latency_ms: number; sqlite_reads: number; sqlite_writes: number }>
  incidents: Array<{ id: string; status: 'open' | 'acknowledged' | 'resolved'; severity: string; title: string; summary: string; opened_at: number; events: Array<{ event_type: string; message: string; occurred_at: number }> }>
  costs: Array<{ environment: string; pricing_version_id: string; observedUsage: Record<string, number>; estimatedCost: { totalUsd: number; dailyUsd: number; projectedMonthlyUsd: number; previousPeriodChange: number | null }; caveats: string[]; calculated_at: number }>
}

const environmentLabels = { dev: 'Development', staging: 'Staging', production: 'Production' }
const healthStyles = {
  healthy: 'monitor-health-status--healthy',
  degraded: 'monitor-health-status--degraded',
  unhealthy: 'monitor-health-status--unhealthy',
  deploying: 'monitor-health-status--deploying',
  unknown: 'monitor-health-status--unknown',
}

const healthLabels = {
  healthy: 'All systems healthy',
  degraded: 'Needs attention',
  unhealthy: 'Service issue',
  deploying: 'Deployment in progress',
  unknown: 'Waiting for data',
}

function formatLatency(value: number | null) {
  if (value === null) return '—'
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`
}

function formatErrorRate(value: number | null) {
  return value === null ? '—' : `${(value * 100).toFixed(value ? 1 : 0)}%`
}

function formatCompactNumber(value: number | undefined) {
  if (value === undefined) return '—'
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatRelativeTime(value: number) {
  if (!value) return 'No check yet'
  const elapsed = Date.now() - value
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

function commandsOf(actor: Actor) {
  return Array.isArray(actor.actions) ? actor.actions : []
}

function statesOf(actor: Actor) {
  return Array.isArray(actor.states) ? actor.states : []
}

function lifecycleStateCount(actor: Actor) {
  return statesOf(actor).reduce((count, state) => count + (Array.isArray(state?.flow) ? state.flow.length : 0), 0)
}

export function MonitorView({ project, onOpenReleases }: { project: string; onOpenReleases?: () => void }) {
  const [actors, setActors] = useState<Actor[]>([])
  const [source, setSource] = useState<'api' | 'local'>('local')
  const [deployments, setDeployments] = useState<DeploymentOverview[]>([])
  const [events, setEvents] = useState<RuntimeEvent[]>([])
  const [environments, setEnvironments] = useState<EnvironmentHealth[]>([])
  const [telemetryConnected, setTelemetryConnected] = useState(false)
  const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [timeRange, setTimeRange] = useState('24h')
  const [environmentFilter, setEnvironmentFilter] = useState('')
  const [releaseFilter, setReleaseFilter] = useState('')
  const [aggregateFilter, setAggregateFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [operations, setOperations] = useState<OperationsOverview | null>(null)

  useEffect(() => {
    let active = true
    loadContracts(project)
      .then((data) => {
        if (!active) return
        setActors(data.actors)
        setSource(data.source)
      })
      .catch((error) => console.error('Failed to load business objects in monitor:', error))
    const loadOverview = () => fetch(`/api/monitor-overview?project=${encodeURIComponent(project)}`)
      .then(async (response) => ({ response, data: await response.json().catch(() => null) }))
      .then(({ response, data }) => {
        if (!active || !response.ok || !data?.success) return
        setDeployments(Array.isArray(data.deployments) ? data.deployments : [])
        setEnvironments(Array.isArray(data.environments) ? data.environments : [])
        setEvents(Array.isArray(data.events) ? data.events : [])
        setTelemetryConnected(true)
      })
      .catch(() => undefined)
    void loadOverview()
    const interval = window.setInterval(loadOverview, 60_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [project])

  useEffect(() => {
    setTimeRange('24h')
    setEnvironmentFilter('')
    setReleaseFilter('')
    setAggregateFilter('')
    setActionFilter('')
  }, [project])

  useEffect(() => {
    let active = true
    const loadMetrics = () => {
      const query = new URLSearchParams({ project, range: timeRange })
      if (environmentFilter) query.set('environment', environmentFilter)
      if (releaseFilter) query.set('release', releaseFilter)
      if (aggregateFilter) query.set('aggregate', aggregateFilter)
      if (actionFilter) query.set('action', actionFilter)
      setMetricsLoading(true)
      return fetch(`/api/runtime-metrics?${query}`)
        .then(async (response) => ({ response, data: await response.json().catch(() => null) }))
        .then(({ response, data }) => {
          if (!active) return
          if (response.ok && data?.success) setMetrics(data)
          else setMetrics(null)
        })
        .catch(() => { if (active) setMetrics(null) })
        .finally(() => { if (active) setMetricsLoading(false) })
    }
    void loadMetrics()
    const interval = window.setInterval(loadMetrics, 60_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [project, timeRange, environmentFilter, releaseFilter, aggregateFilter, actionFilter])

  useEffect(() => {
    let active = true
    const load = () => fetch(`/api/aggregate-operations?project=${encodeURIComponent(project)}`).then(async (response) => ({ response, data: await response.json().catch(() => null) })).then(({response,data}) => { if (active) setOperations(response.ok && data?.success ? data : null) }).catch(() => { if(active)setOperations(null) })
    void load(); const interval=window.setInterval(load,60_000); return()=>{active=false;window.clearInterval(interval)}
  }, [project])

  const updateIncident = async (incidentId: string, action: 'acknowledge' | 'resolve') => {
    const response = await fetch(`/api/incidents/${incidentId}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (!response.ok) return
    setOperations((current) => current ? { ...current, incidents: current.incidents.map((incident) => incident.id === incidentId ? { ...incident, status: action === 'acknowledge' ? 'acknowledged' : 'resolved' } : incident) } : current)
  }

  const summary = useMemo(() => ({
    commands: actors.reduce((count, actor) => count + commandsOf(actor).length, 0),
    stateMachines: actors.reduce((count, actor) => count + statesOf(actor).length, 0),
    states: actors.reduce((count, actor) => count + lifecycleStateCount(actor), 0),
  }), [actors])

  const latestDeployment = deployments[0]
  const successfulDeployments = deployments.filter((deployment) => deployment.status === 'succeeded').length
  const releases = [...new Map(deployments.map((deployment) => [deployment.releaseId, deployment])).values()]
  const aggregates = actors.map((actor) => actor.aggregateType).filter((value): value is string => Boolean(value))
  const actions = [...new Set(actors.flatMap((actor) => commandsOf(actor)))]
  const primaryHealth = environments.find((item) => item.environment === 'production' && item.deployment)
    || environments.find((item) => item.environment === 'staging' && item.deployment)
    || environments.find((item) => item.environment === 'dev' && item.deployment)
  const overallStatus: EnvironmentHealth['status'] = !telemetryConnected || !primaryHealth
    ? 'unknown'
    : environments.some((item) => item.deployment && item.status === 'unhealthy')
      ? 'unhealthy'
      : environments.some((item) => item.deployment && (item.status === 'degraded' || item.stale))
        ? 'degraded'
        : environments.some((item) => item.deployment && item.status === 'deploying')
          ? 'deploying'
          : primaryHealth.status
  const latestHealthCheck = environments.flatMap((item) => item.layers).reduce((latest, layer) => Math.max(latest, layer.checkedAt), 0)
  const activeIncidents = operations?.incidents.filter((incident) => incident.status !== 'resolved') || []
  const nextStep = overallStatus === 'healthy' && !activeIncidents.length
    ? { title: 'No action needed', detail: `Your ${primaryHealth ? environmentLabels[primaryHealth.environment].toLowerCase() : 'runtime'} environment is responding normally.` }
    : activeIncidents.length
      ? { title: `Review ${activeIncidents.length} active incident${activeIncidents.length === 1 ? '' : 's'}`, detail: activeIncidents[0].title }
      : overallStatus === 'unknown'
        ? { title: 'Connect a deployed release', detail: 'Deploy an environment to start live health checks and runtime metrics.' }
        : { title: 'Check runtime health', detail: primaryHealth?.lastFailure?.message || 'One or more runtime layers need attention.' }
  const exportParams = new URLSearchParams({ project, range: timeRange })
  if (environmentFilter) exportParams.set('environment', environmentFilter)
  if (releaseFilter) exportParams.set('release', releaseFilter)
  if (aggregateFilter) exportParams.set('aggregate', aggregateFilter)
  if (actionFilter) exportParams.set('action', actionFilter)

  return (
    <div className="monitor-view">
      <section className={`monitor-overview monitor-overview--${overallStatus}`} aria-labelledby="runtime-overview-heading">
        <div className="monitor-overview__heading">
          <div>
            <span className="monitor-overview__eyebrow">Live runtime overview</span>
            <h1 id="runtime-overview-heading">{project}</h1>
            <p>{overallStatus === 'healthy'
              ? 'Requests are flowing normally through every observed runtime layer.'
              : overallStatus === 'unknown'
                ? 'Your architecture is ready. Live status appears after a release is deployed.'
                : 'The overview below shows where your runtime needs attention.'}</p>
          </div>
          <span className={`monitor-overview__status ${healthStyles[overallStatus]}`}>
            <span className="monitor-overview__status-dot" />
            {healthLabels[overallStatus]}
          </span>
        </div>

        <div className="monitor-flow" aria-label="Request path from application to storage">
          <article className="monitor-flow__node monitor-flow__node--healthy">
            <span className="monitor-flow__icon"><AppWindow aria-hidden="true" /></span>
            <span><small>Your application</small><strong>{project}</strong></span>
          </article>
          <div className={`monitor-flow__link monitor-flow__link--${telemetryConnected ? 'active' : 'idle'}`} aria-hidden="true"><i /><i /></div>
          <article className={`monitor-flow__node monitor-flow__node--${telemetryConnected ? 'healthy' : 'unknown'}`}>
            <span className="monitor-flow__icon"><CloudCog aria-hidden="true" /></span>
            <span><small>API gateway</small><strong>{telemetryConnected ? 'Connected' : 'Awaiting connection'}</strong></span>
          </article>
          <div className={`monitor-flow__link monitor-flow__link--${overallStatus === 'healthy' ? 'active' : 'idle'}`} aria-hidden="true"><i /><i /></div>
          <article className={`monitor-flow__node monitor-flow__node--${overallStatus}`}>
            <span className="monitor-flow__icon"><Cpu aria-hidden="true" /></span>
            <span><small>Lacify runtime</small><strong>{primaryHealth ? environmentLabels[primaryHealth.environment] : 'Not deployed'}</strong></span>
          </article>
          <div className={`monitor-flow__link monitor-flow__link--${overallStatus === 'healthy' ? 'active' : 'idle'}`} aria-hidden="true"><i /><i /></div>
          <article className={`monitor-flow__node monitor-flow__node--${overallStatus}`}>
            <span className="monitor-flow__icon"><Database aria-hidden="true" /></span>
            <span><small>Private storage</small><strong>Durable Object + SQLite</strong></span>
          </article>
        </div>

        <div className="monitor-overview__metrics" aria-label="Key runtime metrics">
          <article><span>Requests</span><strong>{formatCompactNumber(metrics?.summary.requests)}</strong><small>{timeRange === '24h' ? 'last 24 hours' : `last ${timeRange}`}</small></article>
          <article><span>Average latency</span><strong>{formatLatency(metrics?.summary.averageLatencyMs ?? null)}</strong><small>P95 {formatLatency(metrics?.summary.p95LatencyMs ?? null)}</small></article>
          <article><span>Error rate</span><strong>{formatErrorRate(metrics?.summary.errorRate ?? null)}</strong><small>{metrics ? `${metrics.summary.errors.toLocaleString()} failed requests` : 'No telemetry yet'}</small></article>
          <article><span>Active incidents</span><strong>{operations ? activeIncidents.length : '—'}</strong><small>Last check {formatRelativeTime(latestHealthCheck)}</small></article>
        </div>

        <div className="monitor-next-step">
          <span className={`monitor-next-step__icon monitor-next-step__icon--${overallStatus}`}>
            {overallStatus === 'healthy' ? <CheckCircle2 aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          </span>
          <span><small>Recommended next step</small><strong>{nextStep.title}</strong><p>{nextStep.detail}</p></span>
          {overallStatus === 'unknown' && onOpenReleases && <button type="button" onClick={onOpenReleases}>Open releases <GitBranch aria-hidden="true" /></button>}
        </div>
      </section>

      <details className="monitor-technical">
        <summary>
          <span><Info aria-hidden="true" /><span><strong>Technical details</strong><small>Environments, command metrics, storage, incidents, costs, and event logs</small></span></span>
          <ChevronDown className="monitor-technical__chevron" aria-hidden="true" />
        </summary>
        <div className="monitor-technical__content">
          <p className="monitor-demo-notice" role="status">
            <Info className="size-4" />
            {source === 'local'
              ? 'Local Workspace — this view reads business objects stored in this browser. Runtime telemetry needs the Control API.'
              : telemetryConnected
                ? `Control API connected — ${deployments.length} recent deployment job${deployments.length === 1 ? '' : 's'} and ${events.length} runtime event${events.length === 1 ? '' : 's'} loaded.`
                : 'Contract data is connected. Runtime telemetry is currently unavailable.'}
          </p>

      <section className="monitor-environments" aria-label="Runtime environment health">
        {(['dev', 'staging', 'production'] as const).map((environment) => {
          const health = environments.find((item) => item.environment === environment)
          const status = health?.status || 'unknown'
          const checkedAt = health?.layers.reduce((latest, layer) => Math.max(latest, layer.checkedAt), 0) || 0
          return <article className="glass-card monitor-environment-card" key={environment}>
            <div className="monitor-environment-card__header">
              <div><span className="monitor-environment-card__eyebrow">Environment</span><h2>{environmentLabels[environment]}</h2></div>
              <span className={`monitor-health-status ${healthStyles[status]}`}>{status}</span>
            </div>
            {health?.deployment ? <>
              <dl className="monitor-environment-card__metadata">
                <div><dt>Release</dt><dd title={health.deployment.releaseId}>{health.deployment.checksum.slice(0, 12)}</dd></div>
                <div><dt>Last check</dt><dd>{checkedAt ? new Date(checkedAt).toLocaleString() : 'Awaiting deep health data'}</dd></div>
              </dl>
              <div className="monitor-health-layers">
                {(['worker', 'durable_object', 'sqlite'] as const).map((layerName) => {
                  const samples = health.layers.filter((layer) => layer.layer === layerName)
                  const layerHealthy = samples.length > 0 && samples.every((sample) => sample.status === 'healthy')
                  return <span className={samples.length ? layerHealthy ? 'is-healthy' : 'is-unhealthy' : 'is-unknown'} key={layerName}>{layerName.replace('_', ' ')}</span>
                })}
              </div>
              {health.lastFailure && <p className="monitor-environment-card__error">{health.lastFailure.aggregateType ? `${health.lastFailure.aggregateType} · ` : ''}{health.lastFailure.message}</p>}
              <div className="monitor-environment-card__links">
                {onOpenReleases && <button className="monitor-runtime-link" type="button" onClick={onOpenReleases}>Open release workflow <GitBranch className="size-3" /></button>}
                {health.deployment.runtimeUrl && <a className="monitor-runtime-link" href={`${health.deployment.runtimeUrl}/health?deep=1`} target="_blank" rel="noreferrer">Open health endpoint <ExternalLink className="size-3" /></a>}
              </div>
            </> : <div className="monitor-environment-card__empty"><Server className="size-4" /> No release deployed to this environment.</div>}
          </article>
        })}
      </section>

      <section className="glass-card monitor-card monitor-runtime-metrics" aria-labelledby="runtime-metrics-heading">
        <div className="monitor-runtime-metrics__header">
          <div><div className="panel-header flex items-center gap-2 mb-2"><Gauge className="size-5 text-primary" /><h2 id="runtime-metrics-heading" className="text-lg font-bold m-0">Runtime Metrics</h2></div><p className="panel-desc text-xs text-muted-foreground">Observed command telemetry aggregated into five-minute buckets. Percentiles use bounded duration histograms.</p></div>
          <span className="monitor-metric-availability">CPU time: unavailable</span>
        </div>
        <div className="monitor-metric-filters">
          <label>Range<select value={timeRange} onChange={(event) => setTimeRange(event.target.value)}><option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label>
          <label>Environment<select value={environmentFilter} onChange={(event) => setEnvironmentFilter(event.target.value)}><option value="">All environments</option><option value="dev">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label>
          <label>Release<select value={releaseFilter} onChange={(event) => setReleaseFilter(event.target.value)}><option value="">All releases</option>{releases.map((release) => <option value={release.releaseId} key={release.releaseId}>{release.checksum?.slice(0, 12) || release.releaseId.slice(-12)}</option>)}</select></label>
          <label>Aggregate<select value={aggregateFilter} onChange={(event) => setAggregateFilter(event.target.value)}><option value="">All aggregates</option>{aggregates.map((aggregate) => <option value={aggregate} key={aggregate}>{aggregate}</option>)}</select></label>
          <label>Command<select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}><option value="">All commands</option>{actions.map((action) => <option value={action} key={action}>{action}</option>)}</select></label>
        </div>

        {metrics?.summary.requests ? <>
          <div className="monitor-observed-grid">
            <article><Activity className="size-4" /><span>Requests</span><strong>{metrics.summary.requests.toLocaleString()}</strong><small>{metrics.summary.successes.toLocaleString()} successful</small></article>
            <article><TriangleAlert className="size-4" /><span>Error rate</span><strong>{formatErrorRate(metrics.summary.errorRate)}</strong><small>{metrics.summary.errors.toLocaleString()} failed</small></article>
            <article><Timer className="size-4" /><span>Average latency</span><strong>{formatLatency(metrics.summary.averageLatencyMs)}</strong><small>P50 ≈ {formatLatency(metrics.summary.p50LatencyMs)}</small></article>
            <article><Gauge className="size-4" /><span>P95 latency</span><strong>{formatLatency(metrics.summary.p95LatencyMs)}</strong><small>P99 ≈ {formatLatency(metrics.summary.p99LatencyMs)}</small></article>
          </div>
          <div className="overflow-x-auto monitor-command-metrics">
            <table><thead><tr><th>Aggregate / command</th><th>Requests</th><th>Errors</th><th>Error rate</th><th>Average</th><th>P95</th><th>P99</th></tr></thead><tbody>{metrics.commands.map((command) => <tr key={command.key}><td><strong>{command.aggregateType}</strong><span>{command.action}</span></td><td>{command.requests.toLocaleString()}</td><td>{command.errors.toLocaleString()}</td><td>{formatErrorRate(command.errorRate)}</td><td>{formatLatency(command.averageLatencyMs)}</td><td>{formatLatency(command.p95LatencyMs)}</td><td>{formatLatency(command.p99LatencyMs)}</td></tr>)}</tbody></table>
          </div>
        </> : <div className="monitor-empty"><Activity className="size-4" /> {metricsLoading ? 'Loading observed runtime metrics…' : telemetryConnected ? 'No runtime metrics exist for this filter and time range.' : 'Connect Uplink to load runtime metrics.'}</div>}
      </section>

      <div className="monitor-operations-grid">
        <section className="glass-card monitor-card">
          <div className="panel-header flex items-center gap-2 mb-2"><Database className="size-5 text-primary" /><h2 className="text-lg font-bold m-0">Aggregate Storage</h2></div>
          <p className="panel-desc text-xs text-muted-foreground">Business Aggregate → Durable Object → private SQLite. Sizes and row counts are observed from active command partitions.</p>
          {operations?.storage.length ? <div className="overflow-x-auto"><table><thead><tr><th>Aggregate</th><th>Environment</th><th>Storage / threshold</th><th>Growth</th><th>Top tables</th></tr></thead><tbody>{operations.storage.map((item)=><tr key={`${item.environment}-${item.aggregate_type}`}><td>{item.aggregate_type}</td><td>{item.environment}</td><td>{(item.storage_bytes/1024).toFixed(1)} KiB / {(item.thresholdBytes/1073741824).toFixed(0)} GiB</td><td>{item.growthBytes===null?'First sample':`${item.growthBytes>=0?'+':''}${(item.growthBytes/1024).toFixed(1)} KiB${item.growthRate===null?'':` (${(item.growthRate*100).toFixed(1)}%)`}`}</td><td>{item.tableStats.map((table)=>`${table.name}: ${table.rows}`).join(', ')||'Empty'}</td></tr>)}</tbody></table></div>:<div className="monitor-empty">No aggregate storage sample is available yet.</div>}
        </section>
        <section className="glass-card monitor-card">
          <div className="panel-header flex items-center gap-2 mb-2"><Search className="size-5 text-primary" /><h2 className="text-lg font-bold m-0">Privacy-safe Partitions</h2></div>
          <p className="panel-desc text-xs text-muted-foreground">One-way hash prefixes only. Plaintext partition keys are never returned.</p>
          {operations?.partitions.length ? <div className="overflow-x-auto"><table><thead><tr><th>Aggregate / hash</th><th>Requests</th><th>Errors</th><th>SQLite R/W</th></tr></thead><tbody>{operations.partitions.slice(0,10).map((item)=><tr key={`${item.aggregate_type}-${item.partition_hash}`}><td>{item.aggregate_type}<br/><code>{item.partition_hash}…</code></td><td>{item.requests}</td><td>{item.errors}</td><td>{item.sqlite_reads} / {item.sqlite_writes}</td></tr>)}</tbody></table></div>:<div className="monitor-empty">No partition activity exists for the last seven days.</div>}
        </section>
      </div>

      <div className="monitor-operations-grid">
        <section className="glass-card monitor-card">
          <div className="panel-header flex items-center gap-2 mb-2"><TriangleAlert className="size-5 text-primary" /><h2 className="text-lg font-bold m-0">Incidents</h2></div>
          <p className="panel-desc text-xs text-muted-foreground">Deduplicated health, telemetry, latency, error-rate, and storage alerts.</p>
          {operations?.incidents.length ? <div className="monitor-incident-list">{operations.incidents.map((incident)=><article key={incident.id}><div><strong>{incident.title}</strong><span>{incident.severity} · {incident.status} · {incident.events.length} timeline events</span><p>{incident.events[0]?.message || incident.summary}</p></div><div>{incident.status==='open'&&<button onClick={()=>void updateIncident(incident.id,'acknowledge')}>Acknowledge</button>}{incident.status!=='resolved'&&<button onClick={()=>void updateIncident(incident.id,'resolve')}>Resolve</button>}</div></article>)}</div>:<div className="monitor-empty">No incidents recorded.</div>}
        </section>
        <section className="glass-card monitor-card">
          <div className="panel-header flex items-center gap-2 mb-2"><Gauge className="size-5 text-primary" /><h2 className="text-lg font-bold m-0">Cost Visibility</h2></div>
          <p className="panel-desc text-xs text-muted-foreground">Observed usage and gross list-rate estimates. Account-wide allowances and unavailable CPU/DO duration are excluded.</p>
          {operations?.costs.length ? <div className="monitor-cost-list">{operations.costs.slice(0,3).map((cost)=><article key={`${cost.environment}-${cost.calculated_at}`}><span>{cost.environment}</span><strong>${cost.estimatedCost.totalUsd.toFixed(6)}</strong><small>${cost.estimatedCost.dailyUsd.toFixed(6)}/day · projected ${cost.estimatedCost.projectedMonthlyUsd.toFixed(6)}/month</small><small>{cost.observedUsage.requests||0} requests · {cost.pricing_version_id}</small></article>)}</div>:<div className="monitor-empty">No attributable usage exists for this billing period.</div>}
          <div className="monitor-export-links"><a href={`/api/telemetry-export?${exportParams}&format=json`}>Export filtered JSON</a><a href={`/api/telemetry-export?${exportParams}&format=csv`}>Export filtered CSV</a></div>
        </section>
      </div>

      <div className="monitor-metrics-grid">
        <section className="glass-card monitor-metric-card">
          <div className="panel-header flex items-center gap-2 mb-3"><Boxes className="size-5 text-primary" /><h3 className="font-semibold text-sm m-0">Business Objects</h3></div>
          <div className="text-3xl font-extrabold text-foreground">{actors.length}</div>
          <p className="m-0 text-[11px] text-muted-foreground">Defined in this project</p>
        </section>

        <section className="glass-card monitor-metric-card">
          <div className="panel-header flex items-center gap-2 mb-3"><ListChecks className="size-5 text-primary" /><h3 className="font-semibold text-sm m-0">Commands</h3></div>
          <div className="text-3xl font-extrabold text-foreground">{summary.commands}</div>
          <p className="m-0 text-[11px] text-muted-foreground">Configured business actions</p>
        </section>

        <section className="glass-card monitor-metric-card">
          <div className="panel-header flex items-center gap-2 mb-3"><GitBranch className="size-5 text-primary" /><h3 className="font-semibold text-sm m-0">Lifecycle</h3></div>
          <div className="text-3xl font-extrabold text-foreground">{summary.states}</div>
          <p className="m-0 text-[11px] text-muted-foreground">States across {summary.stateMachines} state machine{summary.stateMachines === 1 ? '' : 's'}</p>
        </section>

        <section className="glass-card monitor-metric-card">
          <div className="panel-header flex items-center gap-2 mb-3"><Activity className={`size-5 ${telemetryConnected ? 'text-primary' : 'text-muted-foreground'}`} /><h3 className="font-semibold text-sm m-0">Deployments</h3></div>
          <div className="text-3xl font-extrabold text-foreground">{telemetryConnected ? successfulDeployments : '—'}</div>
          <p className="m-0 text-[11px] text-muted-foreground">{latestDeployment ? `Latest: ${latestDeployment.environment} · ${latestDeployment.status}` : telemetryConnected ? 'No release deployed yet' : 'Control API not connected'}</p>
        </section>
      </div>

      <section className="glass-card monitor-card">
        <div className="panel-header flex items-center gap-2 mb-2"><Search className="size-5 text-primary" /><h2 className="text-lg font-bold m-0">Business Object Explorer</h2></div>
        <p className="panel-desc text-xs text-muted-foreground mb-4">Current contract configuration. These counts are derived from your saved objects, not estimated runtime metrics.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead><tr><th>Business Object</th><th>Commands</th><th>Lifecycle states</th><th>Partition Key</th><th>Runtime target</th><th>Sync</th></tr></thead>
            <tbody>
              {actors.map((actor) => {
                const lifecycleStates = lifecycleStateCount(actor)
                return <tr key={actor.id}>
                  <td className="font-semibold text-foreground">{actor.name}</td><td className="font-mono">{commandsOf(actor).length}</td><td className="font-mono">{lifecycleStates}</td><td className="font-mono text-primary">{actor.key || 'id'}</td><td>Durable Object + SQLite</td>
                  <td><span className={`px-2 py-0.5 rounded-full font-medium uppercase text-[10px] ${source === 'api' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-300'}`}>{source === 'api' ? 'Control API' : 'Local only'}</span></td>
                </tr>
              })}
            </tbody>
          </table>
          {!actors.length && <p className="monitor-empty">No business objects yet. Create one in Build to inspect its contract here.</p>}
        </div>
      </section>

      <div className="monitor-detail-grid">
        <section className="glass-card monitor-card monitor-inspector-card">
          <div>
            <div className="panel-header flex items-center gap-2 mb-2"><Clock className="size-5 text-muted-foreground" /><h2 className="text-lg font-bold m-0">Runtime Events</h2></div>
            <p className="panel-desc text-xs text-muted-foreground mb-4">Runtime events retained by the Control API. No synthetic activity is added.</p>
            {events.length ? <div className="overflow-x-auto"><table className="w-full text-left border-collapse text-xs"><thead><tr><th>Time</th><th>Level</th><th>Object / action</th><th>Message</th></tr></thead><tbody>{events.map((event, index) => <tr key={`${event.occurredAt}-${index}`}><td className="font-mono">{new Date(event.occurredAt).toLocaleString()}</td><td><span className={`px-2 py-0.5 rounded-full font-medium uppercase text-[10px] ${event.level === 'error' ? 'bg-red-500/20 text-red-300' : event.level === 'warning' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-400'}`}>{event.level}</span></td><td className="font-mono">{[event.objectId, event.action].filter(Boolean).join(' / ') || 'runtime'}</td><td>{event.message}</td></tr>)}</tbody></table></div> : <div className="monitor-empty"><Activity className="size-4" /> {telemetryConnected ? 'No runtime events recorded for this project.' : 'Runtime telemetry is unavailable.'}</div>}
          </div>
        </section>

        <section className="glass-card monitor-card">
          <div className="panel-header flex items-center gap-2 mb-2"><Database className="size-5 text-primary" /><h2 className="text-lg font-bold m-0">Configured Runtime Topology</h2></div>
          <p className="panel-desc text-xs text-muted-foreground mb-4">This is the generated topology from the current contract; it does not imply resources are deployed.</p>
          <div className="runtime-topology">
            <div className="text-muted-foreground">Cloudflare runtime target</div>
            <div className="runtime-topology__tree">
              {actors.map((actor) => <div key={actor.id}><span>├── Business Object:</span> {actor.name} ({actor.key || 'id'})<div className="runtime-topology__detail">├── Durable Object boundary<br />└── SQLite storage</div></div>)}
              {!actors.length && <div className="text-muted-foreground">└── No configured objects</div>}
            </div>
          </div>
        </section>
      </div>
        </div>
      </details>
    </div>
  )
}
