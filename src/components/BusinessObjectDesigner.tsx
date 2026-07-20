import { useState } from 'react'
import { Layers, ArrowLeft, Play, Download, Plus, Trash2, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Actor } from '@/components/ActorCard'

interface BusinessObjectDesignerProps {
  actor: Actor
  onClose: () => void
  onDeploy: () => void
  onSaveActor: (actor: Actor) => Promise<void>
}

type TabType = 'contract' | 'sdk' | 'api' | 'readme'

export function BusinessObjectDesigner({ actor, onClose, onDeploy, onSaveActor }: BusinessObjectDesignerProps) {
  const [activeTab, setActiveTab] = useState<TabType>('contract')
  const [isDownloading, setIsDownloading] = useState(false)
  const [selectedAction, setSelectedAction] = useState<string | null>(null)
  const [simSpeed, setSimSpeed] = useState(700)
  const [isSimulating, setIsSimulating] = useState(false)
  const [currentStep, setCurrentStep] = useState<string>('idle')
  const [editor, setEditor] = useState<'object' | 'action' | 'state' | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftFields, setDraftFields] = useState('id, createdAt')
  const [draftStateFlow, setDraftStateFlow] = useState('Draft, Active, Completed')
  const [simLogs, setSimLogs] = useState<string[]>([
    '> Select an Allowed Action above to customize and trigger execution flow.'
  ])

  // Local state for objects, actions, states
  const [objects, setObjects] = useState<Array<{ name: string; fields?: string }>>(
    actor.objects || [
      { name: 'Order', fields: 'id, subtotal, tax, total' },
      { name: 'Product', fields: 'id, name, price, stock' }
    ]
  )
  const [actions, setActions] = useState<string[]>(
    actor.actions || ['CreateOrder', 'AddOrderItem', 'PayOrder']
  )
  const [states, setStates] = useState<Array<{ obj: string; flow: string[] }>>(
    actor.states || [{ obj: 'Order', flow: ['Draft', 'Open', 'Paid', 'Cancelled'] }]
  )

  const aggregateName = actor.name || 'Business Aggregate'
  const aggregateType = actor.aggregateType || 'Outlet'
  const keyName = actor.key || `${aggregateType.toLowerCase()}Id`

  // Auto-sync state changes back to server
  const saveChanges = async (newObjects = objects, newActions = actions, newStates = states) => {
    const updated: Actor = {
      ...actor,
      objects: newObjects,
      actions: newActions,
      states: newStates
    }
    await onSaveActor(updated)
  }

  const openEditor = (kind: 'object' | 'action' | 'state') => {
    setEditor(kind)
    setDraftName(kind === 'state' ? objects[0]?.name || aggregateType : '')
    setDraftFields('id, createdAt')
    setDraftStateFlow('Draft, Active, Completed')
  }

  const handleRemoveObject = (index: number) => {
    if (!confirm('Remove object?')) return
    const updated = objects.filter((_, i) => i !== index)
    setObjects(updated)
    saveChanges(updated, actions, states)
  }

  const handleRemoveAction = (index: number) => {
    const updated = actions.filter((_, i) => i !== index)
    setActions(updated)
    saveChanges(objects, updated, states)
  }

  const submitEditor = (event: React.FormEvent) => {
    event.preventDefault()
    const name = draftName.trim()
    if (!editor || !name) return

    if (editor === 'object') {
      const updated = [...objects, { name, fields: draftFields.trim() || 'id' }]
      setObjects(updated)
      saveChanges(updated, actions, states)
    } else if (editor === 'action') {
      const updated = [...actions, name]
      setActions(updated)
      saveChanges(objects, updated, states)
    } else {
      const flow = draftStateFlow.split(',').map((state) => state.trim()).filter(Boolean)
      if (!flow.length) return
      const updated = [...states, { obj: name, flow }]
      setStates(updated)
      saveChanges(objects, actions, updated)
    }
    setEditor(null)
  }

  const handleRemoveState = (index: number) => {
    const updated = states.filter((_, i) => i !== index)
    setStates(updated)
    saveChanges(objects, actions, updated)
  }

  // Compiler text outputs
  const getYamlContract = () => {
    return `actor:
  id: "${actor.id}"
  name: "${aggregateName}"
  aggregateType: "${aggregateType}"
  key: "${keyName}"
  status: "${actor.status}"

objects:
${(objects || []).map((o) => `  - name: ${o.name}\n    fields: "${o.fields || 'id'}"`).join('\n')}

actions:
${(actions || []).map((a) => `  - ${a}`).join('\n')}

states:
${(states || []).map((s) => `  - obj: ${s.obj}\n    flow: [${(s.flow || []).join(', ')}]`).join('\n')}
`
  }

  const getSdkCode = () => {
    return `// Generated Lacify Client SDK
import { LacifyClient } from '@lacify/sdk';

export class ${aggregateType}Client extends LacifyClient {
${(actions || [])
  .map(
    (act) => `  async ${act.charAt(0).toLowerCase() + act.slice(1)}(${keyName}: string, payload: any) {
    return this.post('/v1/${aggregateType.toLowerCase()}s/' + ${keyName} + '/commands', {
      command: '${act}',
      ...payload
    });
  }`
  )
  .join('\n\n')}
}
`
  }

  const getApiDoc = () => {
    return `// Generated REST API Endpoint Routing
POST /v1/${aggregateType.toLowerCase()}s/:${keyName}/commands

Body Schema:
{
  "command": "${(actions || [])[0] || 'ExecuteCommand'}",
  "timestamp": "${new Date().toISOString()}",
  "payload": { ... }
}

Response (200 OK):
{
  "success": true,
  "aggregateId": ":${keyName}",
  "executedState": "COMPLETED"
}
`
  }

  const getDocumentation = () => {
    return `# Aggregate Documentation: ${aggregateName}

This Business Aggregate models an isolated Durable Object boundary with local SQLite persistence.

- **Partition Key**: \`${keyName}\`
- **Objects**: ${(objects || []).map((o) => o.name).join(', ')}
- **Commands**: ${(actions || []).join(', ')}

Requests wake up the DO, execute business validation, apply state transitions, and persist transaction logs in SQLite before returning back to sleep.
`
  }

  const handleDownloadPackage = async () => {
    setIsDownloading(true)
    try {
      const response = await fetch('/api/compile-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            id: actor.id,
            name: aggregateName,
            aggregateType,
            key: keyName,
            objects,
            actions,
            states
          }
        ])
      })

      if (!response.ok) throw new Error('Download failed')

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${actor.id}-package.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e: any) {
      alert(`Download failed: ${e.message}`)
    } finally {
      setIsDownloading(false)
    }
  }

  // Simulation runner
  const runSimulator = () => {
    const actName = selectedAction || actions[0] || 'CreateOrder'
    setIsSimulating(true)
    setSimLogs([`[Sim] Initiating action execution: ${actName}...`])

    const steps = [
      { id: 'wake', name: 'Wake DO', log: `[1/7] Waking Durable Object partition for ${keyName}...` },
      { id: 'validate', name: 'Validate', log: `[2/7] Validating payload fields for command: ${actName}` },
      { id: 'execute', name: 'Execute', log: `[3/7] Executing aggregate state machine transition...` },
      { id: 'persist', name: 'Persist SQLite', log: `[4/7] Writing transaction record to DO SQLite DB...` },
      { id: 'update-summary', name: 'Update Summary', log: `[5/7] Recalculating aggregated summary metrics...` },
      { id: 'respond', name: 'Respond', log: `[6/7] Emitting HTTP 200 JSON payload response.` },
      { id: 'sleep', name: 'Sleep', log: `[7/7] Durable Object hibernates (Memory released).` }
    ]

    let stepIdx = 0
    const interval = setInterval(() => {
      if (stepIdx < steps.length) {
        const s = steps[stepIdx]
        setCurrentStep(s.id)
        setSimLogs((prev) => [...prev, s.log])
        stepIdx++
      } else {
        clearInterval(interval)
        setIsSimulating(false)
        setCurrentStep('idle')
        setSimLogs((prev) => [...prev, `✔ Simulation finished for ${actName}.`])
      }
    }, simSpeed)
  }

  return (
    <section className="glass-card panel-object-designer workspace-panel object-workbench">
      <div className="panel-header flex-wrap object-workbench__header">
        <div className="object-workbench__title">
          <span className="object-workbench__eyebrow">Business Object</span>
          <div className="flex items-center gap-2">
            <Layers className="panel-icon text-primary" />
            <h2 className="text-xl font-bold">{aggregateName}</h2>
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            <ArrowLeft className="size-4" />
            Back to Workspace
          </Button>
          <Button size="sm" onClick={onDeploy}>
            <Play className="size-4" />
            Compile & Deploy Dev
          </Button>
        </div>
      </div>
      <p className="panel-desc text-xs text-muted-foreground mb-4">
        Define its fields, actions, and lifecycle. Runtime details are available below when you need them.
      </p>

      <div className="object-workbench__summary" aria-label="Business object runtime summary">
        <span><b>Partition key</b><code>{keyName}</code></span>
        <span><b>Runtime</b>Durable Object</span>
        <span><b>Storage</b>SQLite</span>
      </div>

      <div className="designer-grid object-workbench__grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Objects list */}
        <div className="designer-column object-workbench__card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold m-0">Fields & related objects</h3>
            <Button size="xs" variant="outline" type="button" onClick={() => openEditor('object')}>
              <Plus className="size-3" /> Add Object
            </Button>
          </div>
          {editor === 'object' && (
            <form className="object-workbench__add-form" onSubmit={submitEditor}>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Object name, e.g. OrderItem" autoFocus />
              <input value={draftFields} onChange={(event) => setDraftFields(event.target.value)} placeholder="Fields, comma separated" />
              <div><Button size="xs" type="submit">Add object</Button><Button size="xs" variant="ghost" type="button" onClick={() => setEditor(null)}>Cancel</Button></div>
            </form>
          )}
          <div className="space-y-2">
            {objects.map((obj, i) => (
              <div key={i} className="flex items-center justify-between p-2 rounded bg-white/5 text-xs">
                <div>
                  <span className="font-semibold">{obj.name}</span>
                  {obj.fields && <span className="block text-[10px] text-muted-foreground">{obj.fields}</span>}
                </div>
                <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => handleRemoveObject(i)}>
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Commands list */}
        <div className="designer-column object-workbench__card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold m-0">Business Commands</h3>
            <Button size="xs" variant="outline" type="button" onClick={() => openEditor('action')}>
              <Plus className="size-3" /> Add Command
            </Button>
          </div>
          {editor === 'action' && (
            <form className="object-workbench__add-form" onSubmit={submitEditor}>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Command name, e.g. CancelOrder" autoFocus />
              <div><Button size="xs" type="submit">Add command</Button><Button size="xs" variant="ghost" type="button" onClick={() => setEditor(null)}>Cancel</Button></div>
            </form>
          )}
          <div className="space-y-2">
            {actions.map((act, i) => (
              <div
                key={i}
                className={`flex items-center justify-between p-2 rounded cursor-pointer text-xs ${
                  selectedAction === act ? 'bg-primary/20 border border-primary/40' : 'bg-white/5'
                }`}
                onClick={() => setSelectedAction(act)}
              >
                <span className="font-mono">{act}</span>
                <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); handleRemoveAction(i); }}>
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* State Machine list */}
        <div className="designer-column object-workbench__card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold m-0">Object State Machines</h3>
            <Button size="xs" variant="outline" type="button" onClick={() => openEditor('state')}>
              <Plus className="size-3" /> Add State
            </Button>
          </div>
          {editor === 'state' && (
            <form className="object-workbench__add-form" onSubmit={submitEditor}>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Object name" autoFocus />
              <input value={draftStateFlow} onChange={(event) => setDraftStateFlow(event.target.value)} placeholder="States, comma separated" />
              <div><Button size="xs" type="submit">Add lifecycle</Button><Button size="xs" variant="ghost" type="button" onClick={() => setEditor(null)}>Cancel</Button></div>
            </form>
          )}
          <div className="space-y-2">
            {states.map((st, i) => (
              <div key={i} className="p-2 rounded bg-white/5 text-xs relative">
                <div className="flex justify-between items-center mb-1">
                  <span className="font-semibold text-primary">{st.obj}</span>
                  <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => handleRemoveState(i)}>
                    <Trash2 className="size-3" />
                  </Button>
                </div>
                <div className="text-[11px] text-muted-foreground">{(st.flow || []).join(' → ')}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <details className="object-workbench__advanced">
        <summary>Generated contract & API</summary>
        <div className="compiler-tabs-container">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {(['contract', 'sdk', 'api', 'readme'] as TabType[]).map((tab) => (
            <Button
              key={tab}
              size="xs"
              variant={activeTab === tab ? 'default' : 'outline'}
              onClick={() => setActiveTab(tab)}
              className="capitalize"
            >
              {tab === 'contract' ? 'Runtime Contract' : tab === 'sdk' ? 'Generated SDK' : tab === 'api' ? 'Generated API' : 'Documentation'}
            </Button>
          ))}
          <Button
            size="xs"
            variant="secondary"
            className="ml-auto"
            onClick={handleDownloadPackage}
            disabled={isDownloading}
          >
            <Download className="size-3" />
            {isDownloading ? 'Building ZIP...' : 'Download Deployable Package'}
          </Button>
        </div>

        <div className="tab-content-box p-4 rounded-xl bg-black/50 border border-white/10 font-mono text-xs overflow-x-auto max-h-[250px]">
          <pre className="m-0 text-emerald-400">
            {activeTab === 'contract' && getYamlContract()}
            {activeTab === 'sdk' && getSdkCode()}
            {activeTab === 'api' && getApiDoc()}
            {activeTab === 'readme' && getDocumentation()}
          </pre>
        </div>
        </div>
      </details>

      <details className="object-workbench__advanced">
        <summary>Test an action</summary>
        <div className="visualizer-container">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-amber-400" />
            <h3 className="text-sm font-semibold m-0">Action simulator: <span className="text-primary">{selectedAction || actions[0] || 'CreateOrder'}</span></h3>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground">Speed:</label>
            <select
              value={simSpeed}
              onChange={(e) => setSimSpeed(Number(e.target.value))}
              className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-foreground"
            >
              <option value={1200}>0.5x Speed</option>
              <option value={700}>1.0x Speed</option>
              <option value={350}>2.0x Speed</option>
            </select>
            <Button size="xs" onClick={runSimulator} disabled={isSimulating}>
              <Play className="size-3" /> Run Simulator
            </Button>
          </div>
        </div>

        <div className="pipeline-track flex items-center justify-between overflow-x-auto gap-2 p-3 bg-black/30 rounded-xl mb-4 border border-white/5">
          {['wake', 'validate', 'execute', 'persist', 'update-summary', 'respond', 'sleep'].map((step) => (
            <div
              key={step}
              className={`pipeline-step flex flex-col items-center gap-1 text-xs px-3 py-1 rounded transition-all ${
                currentStep === step ? 'bg-primary/20 text-primary font-bold scale-105' : 'text-muted-foreground'
              }`}
            >
              <div className={`step-dot size-2 rounded-full ${currentStep === step ? 'bg-primary animate-ping' : 'bg-white/20'}`} />
              <span className="capitalize">{step.replace('-', ' ')}</span>
            </div>
          ))}
        </div>

        <div className="visualizer-logs-box p-3 rounded-lg bg-black/40 border border-white/5 font-mono text-xs max-h-[120px] overflow-y-auto">
          <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Diagnostic Log</div>
          {simLogs.map((log, i) => (
            <div key={i} className="text-slate-300">{log}</div>
          ))}
        </div>
        </div>
      </details>
    </section>
  )
}
