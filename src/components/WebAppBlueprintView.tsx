import { useEffect, useState } from 'react'
import { CheckSquare, Globe2, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Actor } from '@/components/ActorCard'
import { loadContracts } from '@/lib/contracts'

interface Blueprint { name: string; aggregates: string[] }
const storageKey = (project: string) => `lacify-webapp-blueprint:${project}`

export function WebAppBlueprintView({ project }: { project: string }) {
  const [actors, setActors] = useState<Actor[]>([])
  const [blueprint, setBlueprint] = useState<Blueprint>({ name: `${project} operations`, aggregates: [] })
  const [revision, setRevision] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [apiReady, setApiReady] = useState(false)

  useEffect(() => {
    let active = true
    loadContracts(project).then(({ actors: loaded }) => { if (active) setActors(loaded) }).catch(() => undefined)
    fetch(`/api/projects/${encodeURIComponent(project)}/webapp-blueprint`)
      .then(async (response) => ({ response, data: await response.json().catch(() => null) }))
      .then(({ response, data }) => {
        if (!active || !response.ok || !data?.success) return
        setApiReady(true)
        if (data.blueprint) { setBlueprint(data.blueprint); setRevision(data.blueprint.revision ?? null) }
      })
      .catch(() => undefined)
    try {
      const local = localStorage.getItem(storageKey(project))
      if (local && !apiReady) setBlueprint(JSON.parse(local))
    } catch { /* use default */ }
    return () => { active = false }
  }, [project])

  function toggleAggregate(id: string) {
    setBlueprint((current) => ({ ...current, aggregates: current.aggregates.includes(id) ? current.aggregates.filter((aggregate) => aggregate !== id) : [...current.aggregates, id] }))
  }

  async function save() {
    if (!blueprint.name.trim() || !blueprint.aggregates.length) { setMessage('Enter a name and select at least one aggregate.'); return }
    setSaving(true); setMessage(null)
    try {
      if (apiReady) {
        const response = await fetch(`/api/projects/${encodeURIComponent(project)}/webapp-blueprint`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(revision ? { 'if-match': String(revision) } : {}) }, body: JSON.stringify(blueprint) })
        const data = await response.json().catch(() => null)
        if (!response.ok || !data?.success) throw new Error(data?.message || 'Blueprint could not be saved.')
        setRevision(data.blueprint.revision); setMessage('Blueprint saved. Compile a new release to include the web app artifact.')
      } else {
        localStorage.setItem(storageKey(project), JSON.stringify(blueprint)); setMessage('Saved locally. Connect the Control API to include this blueprint in a release.')
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Blueprint could not be saved.') } finally { setSaving(false) }
  }

  return <section className="webapp-blueprint">
    <div className="webapp-blueprint__header"><div><p className="workspace-kicker">Web app</p><h2>Command console blueprint</h2><p>Generate a React operations console for explicit aggregate commands. Customer-facing screens are added as dedicated blueprint modules later.</p></div><Globe2 className="size-5" /></div>
    <div className="webapp-blueprint__grid"><div className="webapp-blueprint__panel"><label>Application name<input value={blueprint.name} onChange={(event) => setBlueprint((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Jakarta retail operations" /></label><div className="webapp-blueprint__section"><div><h3>Expose aggregates</h3><p>Select command routes available in the generated web app.</p></div>{actors.length ? <div className="blueprint-aggregate-list">{actors.map((actor) => <label className="blueprint-aggregate" key={actor.id}><input type="checkbox" checked={blueprint.aggregates.includes(actor.id)} onChange={() => toggleAggregate(actor.id)} /><span><strong>{actor.name}</strong><small>{actor.actions?.length || 0} commands · key: {actor.key || 'id'}</small></span><CheckSquare className="size-4" /></label>)}</div> : <p className="webapp-blueprint__empty">Create an aggregate in Architecture before building a web app.</p>}</div><Button onClick={save} disabled={saving}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}{saving ? 'Saving…' : 'Save blueprint'}</Button>{message && <p className="webapp-blueprint__message" role="status">{message}</p>}</div><aside className="webapp-blueprint__panel webapp-blueprint__aside"><p className="workspace-kicker">Generated output</p><h3>React operations console</h3><ul><li>Aggregate and command selector</li><li>Partition-key input</li><li>JSON payload editor</li><li>Runtime lifecycle response</li></ul><p>After saving, compile a new release from Releases. The artifact will contain a <code>webapp-react</code> project.</p></aside></div>
  </section>
}
