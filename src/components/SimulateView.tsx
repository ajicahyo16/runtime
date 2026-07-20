import { useState, useEffect } from 'react'
import { Server, Database, Play, Code } from 'lucide-react'
import { Button } from '@/components/ui/button'
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

export function SimulateView({ project }: { project: string }) {
  const [actors, setActors] = useState<Actor[]>([])
  const [selectedActor, setSelectedActor] = useState<Actor | null>(null)
  const [rows, setRows] = useState<SqliteRow[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [sdkOverlayCode, setSdkOverlayCode] = useState<string | null>(null)

  useEffect(() => {
    loadActors()
  }, [project])

  const loadActors = async () => {
    try {
      const response = await fetch(`/api/load-contracts?project=${project}`)
      const data = await response.json()
      if (data.success && data.actors) {
        setActors(data.actors)
        if (data.actors.length > 0) {
          selectActor(data.actors[0])
        }
      }
    } catch (e) {
      console.error('Failed to load actors in simulate view:', e)
    }
  }

  const selectActor = (actor: Actor) => {
    setSelectedActor(actor)
    // Generate initial mock SQLite rows for this actor
    const primaryObj = actor.objects?.[0]?.name || 'Record'
    const initialState = actor.states?.[0]?.flow?.[0] || 'DRAFT'

    setRows([
      {
        id: `${actor.key || 'id'}_101`,
        type: primaryObj,
        state: initialState,
        data: JSON.stringify({ name: 'Sample Item A', quantity: 10 })
      },
      {
        id: `${actor.key || 'id'}_102`,
        type: primaryObj,
        state: initialState,
        data: JSON.stringify({ name: 'Sample Item B', quantity: 25 })
      }
    ])
  }

  const triggerCommand = (actionName: string) => {
    if (!selectedActor) return

    const keyVal = `${selectedActor.key || 'id'}_${Math.floor(100 + Math.random() * 900)}`
    const primaryObj = selectedActor.objects?.[0]?.name || 'Record'
    const statesFlow = selectedActor.states?.[0]?.flow || ['DRAFT', 'COMPLETED']
    const nextState = statesFlow[Math.floor(Math.random() * statesFlow.length)]

    // Trigger overlay code snippet
    const codeSnippet = `await client.${actionName.charAt(0).toLowerCase() + actionName.slice(1)}("${keyVal}", {\n  timestamp: Date.now()\n});`
    setSdkOverlayCode(codeSnippet)

    setTimeout(() => {
      setSdkOverlayCode(null)
    }, 2500)

    // Add new row to SQLite state inspector
    const newRow: SqliteRow = {
      id: keyVal,
      type: primaryObj,
      state: nextState,
      data: JSON.stringify({ action: actionName, status: 'PROCESSED' })
    }
    setRows((prev) => [newRow, ...prev])

    // Add log entry to audit ledger
    const logItem: AuditLog = {
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      text: `[SDK] ${selectedActor.name} executed command "${actionName}". DO State updated to ${nextState}.`,
      type: 'success'
    }
    setAuditLogs((prev) => [logItem, ...prev])
  }

  return (
    <div className="space-y-6 relative">
      {/* Floating Code Overlay */}
      {sdkOverlayCode && (
        <div className="fixed bottom-6 right-6 z-50 p-4 rounded-xl bg-black/90 border border-primary/40 shadow-2xl backdrop-blur-md max-w-md animate-in fade-in slide-in-from-bottom-5">
          <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-primary">
            <Code className="size-4" />
            SDK Client Request Triggered
          </div>
          <pre className="p-3 rounded bg-black/60 font-mono text-xs text-emerald-400 m-0 overflow-x-auto">
            {sdkOverlayCode}
          </pre>
          <div className="text-[10px] text-muted-foreground mt-2">Running background routing to correct Durable Object partition...</div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Aggregates list & Operations */}
        <div className="lg:col-span-4 space-y-6">
          {/* Select Aggregate */}
          <section className="glass-card p-5">
            <div className="panel-header flex items-center gap-2 mb-2">
              <Server className="size-5 text-primary" />
              <h2 className="text-base font-bold m-0">Select Aggregate</h2>
            </div>
            <p className="panel-desc text-xs text-muted-foreground mb-4">Select designed boundary to trigger local simulation.</p>

            <div className="space-y-2">
              {actors.map((actor) => (
                <button
                  key={actor.id}
                  onClick={() => selectActor(actor)}
                  className={`w-full text-left p-3 rounded-lg text-xs font-medium transition-all flex justify-between items-center ${
                    selectedActor?.id === actor.id
                      ? 'bg-primary/20 border border-primary/40 text-primary font-bold'
                      : 'bg-black/30 border border-white/5 text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <span>{actor.name}</span>
                  <span className="text-[10px] text-muted-foreground uppercase">{actor.status}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Command Operations */}
          {selectedActor && (
            <section className="glass-card p-5">
              <div className="panel-header flex items-center gap-2 mb-2">
                <Play className="size-5 text-emerald-400" />
                <h2 className="text-base font-bold m-0">{selectedActor.name} Operations</h2>
              </div>
              <p className="panel-desc text-xs text-muted-foreground mb-4">Trigger compiled SDK command functions to simulate business transactions.</p>

              <div className="space-y-2">
                {(selectedActor.actions || ['CreateOrder', 'AddOrderItem', 'PayOrder']).map((act) => (
                  <Button
                    key={act}
                    variant="outline"
                    size="sm"
                    className="w-full justify-start font-mono text-xs"
                    onClick={() => triggerCommand(act)}
                  >
                    <Play className="size-3 text-emerald-400 mr-2" />
                    {act}()
                  </Button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right Column: SQLite Table & Audit Event Stream */}
        <div className="lg:col-span-8 space-y-6">
          {/* SQLite Table */}
          <section className="glass-card p-6">
            <div className="panel-header flex items-center gap-2 mb-2">
              <Database className="size-5 text-purple-400" />
              <h2 className="text-base font-bold m-0">SQLite Database Table (Inside Durable Object)</h2>
            </div>
            <p className="panel-desc text-xs text-muted-foreground mb-4">
              Displays live SQLite table values persisting state partitions inside this specific DO context.
            </p>

            <div className="overflow-x-auto min-h-[200px]">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-muted-foreground uppercase text-[10px]">
                    <th className="p-2">Record ID</th>
                    <th className="p-2">Object Type</th>
                    <th className="p-2">Current State</th>
                    <th className="p-2">Data Payload</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-[11px] text-slate-300">
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-center py-8 text-muted-foreground italic">
                        Select an aggregate on the left to inspect SQLite tables.
                      </td>
                    </tr>
                  ) : (
                    rows.map((row, i) => (
                      <tr key={i} className="hover:bg-white/5 transition-colors">
                        <td className="p-2.5 font-bold text-primary">{row.id}</td>
                        <td className="p-2.5">{row.type}</td>
                        <td className="p-2.5">
                          <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 font-medium">
                            {row.state}
                          </span>
                        </td>
                        <td className="p-2.5 text-slate-400 truncate max-w-[250px]">{row.data}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Audit Event Ledger */}
          <section className="glass-card p-6">
            <div className="panel-header flex items-center gap-2 mb-2">
              <Code className="size-5 text-amber-400" />
              <h2 className="text-base font-bold m-0">Audit Event Ledger</h2>
            </div>
            <p className="panel-desc text-xs text-muted-foreground mb-4">Emitted transaction event stream records generated by aggregate state transitions.</p>

            <div className="p-3 rounded-xl bg-black/40 border border-white/5 font-mono text-xs max-h-[220px] overflow-y-auto space-y-2">
              {auditLogs.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground italic">
                  No events emitted. Run a command on the left to start transaction simulation.
                </div>
              ) : (
                auditLogs.map((log, i) => (
                  <div key={i} className="text-emerald-400 flex items-start gap-2">
                    <span className="text-[10px] text-muted-foreground shrink-0">{log.time}</span>
                    <span>{log.text}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
