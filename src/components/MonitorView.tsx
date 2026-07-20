import { useEffect, useMemo, useState } from 'react'
import { Activity, Boxes, Clock, Database, GitBranch, Info, ListChecks, Search } from 'lucide-react'
import type { Actor } from '@/components/ActorCard'
import { loadContracts } from '@/lib/contracts'

function commandsOf(actor: Actor) {
  return Array.isArray(actor.actions) ? actor.actions : []
}

function statesOf(actor: Actor) {
  return Array.isArray(actor.states) ? actor.states : []
}

function lifecycleStateCount(actor: Actor) {
  return statesOf(actor).reduce((count, state) => count + (Array.isArray(state?.flow) ? state.flow.length : 0), 0)
}

export function MonitorView({ project }: { project: string }) {
  const [actors, setActors] = useState<Actor[]>([])
  const [source, setSource] = useState<'api' | 'local'>('local')

  useEffect(() => {
    loadContracts(project)
      .then((data) => {
        setActors(data.actors)
        setSource(data.source)
      })
      .catch((error) => console.error('Failed to load business objects in monitor:', error))
  }, [project])

  const summary = useMemo(() => ({
    commands: actors.reduce((count, actor) => count + commandsOf(actor).length, 0),
    stateMachines: actors.reduce((count, actor) => count + statesOf(actor).length, 0),
    states: actors.reduce((count, actor) => count + lifecycleStateCount(actor), 0),
  }), [actors])

  return (
    <div className="monitor-view">
      <p className="monitor-demo-notice" role="status">
        <Info className="size-4" />
        {source === 'local'
          ? 'Local Workspace — this view reads business objects stored in this browser. Runtime telemetry needs the Control API.'
          : 'Contract data is connected. Runtime telemetry, cost, and Cloudflare health checks will appear after the Control API is configured.'}
      </p>

      <div className="monitor-metrics-grid">
        <section className="glass-card monitor-metric-card">
          <div className="panel-header flex items-center gap-2 mb-3"><Boxes className="size-5 text-primary" /><h3 className="font-semibold text-sm m-0">Business Objects</h3></div>
          <div className="text-3xl font-extrabold text-foreground">{actors.length}</div>
          <p className="m-0 text-[11px] text-muted-foreground">Defined in this project</p>
        </section>

        <section className="glass-card monitor-metric-card">
          <div className="panel-header flex items-center gap-2 mb-3"><ListChecks className="size-5 text-sky-400" /><h3 className="font-semibold text-sm m-0">Commands</h3></div>
          <div className="text-3xl font-extrabold text-foreground">{summary.commands}</div>
          <p className="m-0 text-[11px] text-muted-foreground">Configured business actions</p>
        </section>

        <section className="glass-card monitor-metric-card">
          <div className="panel-header flex items-center gap-2 mb-3"><GitBranch className="size-5 text-purple-400" /><h3 className="font-semibold text-sm m-0">Lifecycle</h3></div>
          <div className="text-3xl font-extrabold text-foreground">{summary.states}</div>
          <p className="m-0 text-[11px] text-muted-foreground">States across {summary.stateMachines} state machine{summary.stateMachines === 1 ? '' : 's'}</p>
        </section>

        <section className="glass-card monitor-metric-card">
          <div className="panel-header flex items-center gap-2 mb-3"><Activity className="size-5 text-amber-400" /><h3 className="font-semibold text-sm m-0">Runtime Telemetry</h3></div>
          <div className="text-sm font-bold text-amber-300">Not connected</div>
          <p className="m-0 text-[11px] text-muted-foreground">Connect the Control API after deployment to receive live health and usage.</p>
        </section>
      </div>

      <section className="glass-card monitor-card">
        <div className="panel-header flex items-center gap-2 mb-2"><Search className="size-5 text-primary" /><h2 className="text-lg font-bold m-0">Business Object Explorer</h2></div>
        <p className="panel-desc text-xs text-muted-foreground mb-4">Current contract configuration. These counts are derived from your saved objects, not estimated runtime metrics.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead><tr className="border-b border-white/10 text-muted-foreground uppercase text-[10px]"><th>Business Object</th><th>Commands</th><th>Lifecycle states</th><th>Partition Key</th><th>Runtime target</th><th>Sync</th></tr></thead>
            <tbody className="divide-y divide-white/5 text-slate-300">
              {actors.map((actor) => {
                const lifecycleStates = lifecycleStateCount(actor)
                return <tr key={actor.id} className="hover:bg-white/5 transition-colors">
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
            <div className="panel-header flex items-center gap-2 mb-2"><Clock className="size-5 text-amber-400" /><h2 className="text-lg font-bold m-0">Runtime Events</h2></div>
            <p className="panel-desc text-xs text-muted-foreground mb-4">Runtime events are retained by the deployed Control API. No synthetic events are shown here.</p>
            <div className="monitor-empty"><Activity className="size-4" /> No telemetry available. Deploy a release and connect the Control API to stream runtime events.</div>
          </div>
        </section>

        <section className="glass-card monitor-card">
          <div className="panel-header flex items-center gap-2 mb-2"><Database className="size-5 text-sky-400" /><h2 className="text-lg font-bold m-0">Configured Runtime Topology</h2></div>
          <p className="panel-desc text-xs text-muted-foreground mb-4">This is the generated topology from the current contract; it does not imply resources are deployed.</p>
          <div className="p-4 rounded-xl bg-black/30 border border-white/5 font-mono text-xs space-y-2">
            <div className="text-muted-foreground">Cloudflare runtime target</div>
            <div className="pl-4 border-l border-white/10 space-y-2">
              {actors.map((actor) => <div key={actor.id}><span className="text-sky-400">├── Business Object:</span> {actor.name} ({actor.key || 'id'})<div className="pl-6 text-[11px] text-muted-foreground">├── Durable Object boundary<br />└── SQLite storage</div></div>)}
              {!actors.length && <div className="text-muted-foreground">└── No configured objects</div>}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
