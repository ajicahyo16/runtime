import { useState } from 'react'
import { Layers, ArrowLeft, Play, Download, Plus, Trash2, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Actor } from '@/components/ActorCard'
import { validateContract } from '@/lib/contract-validation'

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
  const [saveError, setSaveError] = useState<string | null>(null)

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
    const validation = validateContract(updated)
    if (!validation.valid) {
      setSaveError(validation.issues[0].message)
      return
    }
    try {
      await onSaveActor(updated)
      setSaveError(null)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The contract could not be saved.')
    }
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
      <header className="object-workbench__header">
        <div className="object-workbench__title">
          <span className="object-workbench__eyebrow">Aggregate definition</span>
          <div className="object-workbench__heading"><span className="object-workbench__icon"><Layers className="size-5" /></span><h1>{aggregateName}</h1></div>
          <p>Define the data boundary, allowed commands, and state transitions for this aggregate.</p>
        </div>
        <div className="object-workbench__actions">
          <Button variant="outline" size="sm" onClick={onClose}>
            <ArrowLeft className="size-3.5" />
            All aggregates
          </Button>
          <Button size="sm" onClick={onDeploy}>
            <Play className="size-3.5" />
            View release checks
          </Button>
        </div>
      </header>
      {saveError && <p className="contract-validation-error" role="alert">{saveError}</p>}

      <div className="object-workbench__summary" aria-label="Business object runtime summary">
        <div><span>Partition key</span><code>{keyName}</code></div>
        <div><span>Runtime</span><strong>Durable Object</strong></div>
        <div><span>Storage</span><strong>SQLite</strong></div>
      </div>

      <div className="object-workbench__grid">
        {/* Objects list */}
        <section className="object-workbench__card">
          <div className="object-workbench__card-header">
            <div><h2>Data objects</h2><p>Records owned by this aggregate</p></div>
            <Button size="xs" variant="outline" type="button" onClick={() => openEditor('object')}>
              <Plus className="size-3" /> Add
            </Button>
          </div>
          {editor === 'object' && (
            <form className="object-workbench__add-form" onSubmit={submitEditor}>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Object name, e.g. OrderItem" autoFocus />
              <input value={draftFields} onChange={(event) => setDraftFields(event.target.value)} placeholder="Fields, comma separated" />
              <div><Button size="xs" type="submit">Add object</Button><Button size="xs" variant="ghost" type="button" onClick={() => setEditor(null)}>Cancel</Button></div>
            </form>
          )}
          <div className="object-workbench__items">
            {objects.map((obj, i) => (
              <div key={i} className="object-workbench__item">
                <div>
                  <strong>{obj.name}</strong>
                  {obj.fields && <span>{obj.fields}</span>}
                </div>
                <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => handleRemoveObject(i)}>
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        {/* Commands list */}
        <section className="object-workbench__card">
          <div className="object-workbench__card-header">
            <div><h2>Commands</h2><p>Actions allowed for this boundary</p></div>
            <Button size="xs" variant="outline" type="button" onClick={() => openEditor('action')}>
              <Plus className="size-3" /> Add
            </Button>
          </div>
          {editor === 'action' && (
            <form className="object-workbench__add-form" onSubmit={submitEditor}>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Command name, e.g. CancelOrder" autoFocus />
              <div><Button size="xs" type="submit">Add command</Button><Button size="xs" variant="ghost" type="button" onClick={() => setEditor(null)}>Cancel</Button></div>
            </form>
          )}
          <div className="object-workbench__items">
            {actions.map((act, i) => (
              <div
                key={i}
                className={`object-workbench__item object-workbench__command ${selectedAction === act ? 'is-selected' : ''}`}
                onClick={() => setSelectedAction(act)}
              >
                <strong>{act}</strong>
                <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); handleRemoveAction(i); }}>
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        {/* State Machine list */}
        <section className="object-workbench__card">
          <div className="object-workbench__card-header">
            <div><h2>State machines</h2><p>Valid transitions for each record</p></div>
            <Button size="xs" variant="outline" type="button" onClick={() => openEditor('state')}>
              <Plus className="size-3" /> Add
            </Button>
          </div>
          {editor === 'state' && (
            <form className="object-workbench__add-form" onSubmit={submitEditor}>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Object name" autoFocus />
              <input value={draftStateFlow} onChange={(event) => setDraftStateFlow(event.target.value)} placeholder="States, comma separated" />
              <div><Button size="xs" type="submit">Add lifecycle</Button><Button size="xs" variant="ghost" type="button" onClick={() => setEditor(null)}>Cancel</Button></div>
            </form>
          )}
          <div className="object-workbench__items">
            {states.map((st, i) => (
              <div key={i} className="object-workbench__item object-workbench__state">
                <div>
                  <strong>{st.obj}</strong>
                  <span>{(st.flow || []).join(' → ')}</span>
                </div>
                  <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => handleRemoveState(i)}>
                    <Trash2 className="size-3" />
                  </Button>
              </div>
            ))}
          </div>
        </section>
      </div>

      <details className="object-workbench__advanced">
        <summary>
          <span>Generated contract & API</span>
          <small>Review the files produced from this definition</small>
        </summary>
        <div className="object-workbench__generated">
          <div className="object-workbench__advanced-header">
            <div>
              <span className="object-workbench__section-label">Output preview</span>
              <p>Each file is regenerated when the aggregate changes.</p>
            </div>
            <Button size="xs" variant="outline" onClick={handleDownloadPackage} disabled={isDownloading}>
              <Download className="size-3" />
              {isDownloading ? 'Building package…' : 'Download package'}
            </Button>
          </div>
          <div className="object-workbench__tabs" role="tablist" aria-label="Generated files">
            {(['contract', 'sdk', 'api', 'readme'] as TabType[]).map((tab) => (
              <Button
                key={tab}
                size="xs"
                variant={activeTab === tab ? 'default' : 'ghost'}
                onClick={() => setActiveTab(tab)}
                className="capitalize"
              >
                {tab === 'contract' ? 'Contract' : tab === 'sdk' ? 'SDK' : tab === 'api' ? 'API' : 'Docs'}
              </Button>
            ))}
          </div>
          <div className="object-workbench__code" aria-live="polite">
            <pre>
              {activeTab === 'contract' && getYamlContract()}
              {activeTab === 'sdk' && getSdkCode()}
              {activeTab === 'api' && getApiDoc()}
              {activeTab === 'readme' && getDocumentation()}
            </pre>
          </div>
        </div>
      </details>

      <details className="object-workbench__advanced">
        <summary>
          <span>Test an action</span>
          <small>Run a local lifecycle preview before release</small>
        </summary>
        <div className="object-workbench__simulator">
          <div className="object-workbench__advanced-header">
            <div className="object-workbench__simulator-title">
              <Activity className="size-4" />
              <div>
                <span className="object-workbench__section-label">Action simulator</span>
                <p>{selectedAction || actions[0] || 'CreateOrder'} · local preview only</p>
              </div>
            </div>
            <div className="object-workbench__simulator-actions">
              <label>
                <span>Speed</span>
                <select
                  value={simSpeed}
                  onChange={(e) => setSimSpeed(Number(e.target.value))}
                >
                  <option value={1200}>0.5×</option>
                  <option value={700}>1×</option>
                  <option value={350}>2×</option>
                </select>
              </label>
              <Button size="xs" onClick={runSimulator} disabled={isSimulating}>
                <Play className="size-3" /> {isSimulating ? 'Running…' : 'Run preview'}
              </Button>
            </div>
          </div>

        <div className="object-workbench__pipeline" aria-label="Action execution stages">
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

        <div className="object-workbench__logs">
          <div>Diagnostic log</div>
          {simLogs.map((log, i) => (
            <p key={i}>{log}</p>
          ))}
        </div>
        </div>
      </details>
    </section>
  )
}
