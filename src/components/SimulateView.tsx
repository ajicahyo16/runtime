import { useEffect, useRef, useState } from 'react'
import { Check, Circle, Code, Database, Play, Server, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { loadContracts } from '@/lib/contracts'
import type { Actor } from '@/components/ActorCard'

interface SqliteRow {
  id: string
  type: string
  state: string
  data: string
}

interface AuditLog {
  time: string
  text: string
  type: 'info' | 'success' | 'warn'
}

const lifecycle = ['Wake', 'Validate', 'Execute', 'Persist', 'Update summary', 'Respond', 'Sleep']

const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function rowsFor(actor: Actor): SqliteRow[] {
  const object = actor.objects?.[0]?.name || actor.aggregateType || 'Record'
  const state = actor.states?.find((item) => item.obj === object)?.flow?.[0] || actor.states?.[0]?.flow?.[0] || 'Draft'
  return [
    { id: `${actor.key || 'id'}_101`, type: object, state, data: JSON.stringify({ name: 'Sample item A', quantity: 10 }) },
    { id: `${actor.key || 'id'}_102`, type: object, state, data: JSON.stringify({ name: 'Sample item B', quantity: 25 }) },
  ]
}

export function SimulateView({ project }: { project: string }) {
  const [actors, setActors] = useState<Actor[]>([])
  const [selectedActor, setSelectedActor] = useState<Actor | null>(null)
  const [rows, setRows] = useState<SqliteRow[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [activeStep, setActiveStep] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const runId = useRef(0)

  useEffect(() => {
    let current = true
    runId.current += 1
    setLoadError(null)
    setActors([])
    setSelectedActor(null)
    setRows([])
    setAuditLogs([])
    setActiveStep(null)
    setIsRunning(false)

    loadContracts(project)
      .then(({ actors: loaded }) => {
        if (!current) return
        setActors(loaded)
        if (loaded[0]) selectActor(loaded[0])
      })
      .catch((error: unknown) => {
        if (current) setLoadError(error instanceof Error ? error.message : 'Business objects could not be loaded.')
      })

    return () => {
      current = false
      runId.current += 1
    }
  }, [project])

  function selectActor(actor: Actor) {
    if (isRunning) return
    setSelectedActor(actor)
    setRows(rowsFor(actor))
    setActiveStep(null)
  }

  async function triggerCommand(actionName: string) {
    if (!selectedActor || isRunning) return

    const run = ++runId.current
    const actor = selectedActor
    const object = actor.objects?.[0]?.name || actor.aggregateType || 'Record'
    const stateFlow = actor.states?.find((item) => item.obj === object)?.flow || actor.states?.[0]?.flow || ['Draft', 'Completed']
    const currentState = rows[0]?.state
    const currentIndex = Math.max(0, stateFlow.findIndex((state) => state === currentState))
    const nextState = stateFlow[(currentIndex + 1) % stateFlow.length] || 'Completed'
    const id = `${actor.key || 'id'}_${String(Date.now()).slice(-6)}`

    setIsRunning(true)
    setAuditLogs((previous) => [{ time: time(), text: `${actionName} accepted for local lifecycle preview.`, type: 'info' }, ...previous])

    for (let step = 0; step < lifecycle.length; step += 1) {
      if (run !== runId.current) return
      setActiveStep(step)
      await new Promise((resolve) => window.setTimeout(resolve, 260))
      if (run !== runId.current) return

      if (lifecycle[step] === 'Persist') {
        const row: SqliteRow = {
          id,
          type: object,
          state: nextState,
          data: JSON.stringify({ command: actionName, preview: true, status: 'persisted' }),
        }
        setRows((previous) => [row, ...previous])
      }
    }

    if (run === runId.current) {
      setAuditLogs((previous) => [{ time: time(), text: `${actor.name} transitioned to ${nextState}. No deployed runtime or production data was changed.`, type: 'success' }, ...previous])
      setIsRunning(false)
      setActiveStep(null)
    }
  }

  const selectedCommand = selectedActor?.actions?.[0] || 'Run command'

  return (
    <div className="simulate-view">
      <section className="simulate-notice" role="status">
        <ShieldCheck className="size-4 shrink-0" />
        <div><strong>Local preview only.</strong> This is a browser-session simulation. It does not call a deployed Worker, SQLite database, or production environment.</div>
      </section>

      <section className="simulate-lifecycle" aria-label="Request lifecycle">
        <div>
          <p className="simulate-eyebrow">Request-response lifecycle</p>
          <h2>{isRunning ? 'Processing local command' : 'Ready to test a command'}</h2>
          <p>{selectedActor ? `${selectedActor.name} · ${selectedCommand}` : 'Select an aggregate to begin.'}</p>
        </div>
        <ol className="simulate-steps">
          {lifecycle.map((step, index) => {
            const complete = activeStep !== null && index < activeStep
            const active = activeStep === index
            return <li key={step} className={complete ? 'complete' : active ? 'active' : ''}>
              <span>{complete ? <Check className="size-3" /> : <Circle className="size-3" />}</span>{step}
            </li>
          })}
        </ol>
      </section>

      <div className="simulate-workbench">
        <aside className="simulate-sidebar">
          <section className="simulate-panel">
            <div className="simulate-panel__heading"><Server className="size-4" /><div><h2>Aggregate</h2><p>Choose the draft contract to test.</p></div></div>
            {loadError ? <p className="simulate-error">{loadError}</p> : actors.length === 0 ? <p className="simulate-empty">No business objects exist in this project yet.</p> : (
              <div className="simulate-actor-list">{actors.map((actor) => <button key={actor.id} type="button" onClick={() => selectActor(actor)} disabled={isRunning} className={`simulate-actor ${selectedActor?.id === actor.id ? 'selected' : ''}`}><span><strong>{actor.name}</strong><small>{actor.aggregateType} · key: {actor.key}</small></span><span>{actor.status}</span></button>)}</div>
            )}
          </section>

          {selectedActor && <section className="simulate-panel simulate-commands">
            <div className="simulate-panel__heading"><Play className="size-4" /><div><h2>Commands</h2><p>Each run advances the configured state flow.</p></div></div>
            <div className="simulate-command-list">{(selectedActor.actions?.length ? selectedActor.actions : ['Run command']).map((action) => <Button key={action} variant="outline" size="sm" onClick={() => triggerCommand(action)} disabled={isRunning}><Play className="size-3" />{isRunning ? 'Running lifecycle…' : action}</Button>)}</div>
          </section>}
        </aside>

        <div className="simulate-output">
          <section className="simulate-panel">
            <div className="simulate-panel__heading"><Database className="size-4" /><div><h2>State preview</h2><p>In-memory records produced by the persist step. Cleared on reload.</p></div></div>
            <div className="overflow-x-auto min-h-[200px]"><table className="simulate-table"><thead><tr><th>Record ID</th><th>Object type</th><th>State</th><th>Data payload</th></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={4} className="simulate-empty">Select an aggregate to inspect its preview.</td></tr> : rows.map((row) => <tr key={row.id}><td>{row.id}</td><td>{row.type}</td><td><span className="simulate-state">{row.state}</span></td><td title={row.data}>{row.data}</td></tr>)}</tbody></table></div>
          </section>

          <section className="simulate-panel">
            <div className="simulate-panel__heading"><Code className="size-4" /><div><h2>Preview event log</h2><p>Trace generated by this browser-only simulation.</p></div></div>
            <div className="simulate-log">{auditLogs.length === 0 ? <div className="simulate-empty">Run a command to see the local lifecycle trace.</div> : auditLogs.map((log, index) => <div key={`${log.time}-${index}`} className={`simulate-log-entry ${log.type}`}><time>{log.time}</time><span>{log.text}</span></div>)}</div>
          </section>
        </div>
      </div>
    </div>
  )
}
