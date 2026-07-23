import { useEffect, useState } from 'react'
import { ArrowRight, Server, Sparkles, Plus } from 'lucide-react'
import { ActorCard, type Actor } from '@/components/ActorCard'
import { Button } from '@/components/ui/button'
import { deleteContract, loadContracts } from '@/lib/contracts'

interface ActorsGridProps {
  onActorClick: (actor: Actor) => void
  onAddBusinessObject: () => void
  onAIBuilder: () => void
  project: string
  reloadKey?: number
}

export function ActorsGrid({
  onActorClick,
  onAddBusinessObject,
  onAIBuilder,
  project,
  reloadKey = 0
}: ActorsGridProps) {
  const [actors, setActors] = useState<Actor[]>([])
  const [loading, setLoading] = useState(true)
  const [isLocalWorkspace, setIsLocalWorkspace] = useState(false)

  useEffect(() => {
    loadActors()
  }, [reloadKey, project])

  async function loadActors() {
    try {
      const data = await loadContracts(project)
      setActors(data.actors)
      setIsLocalWorkspace(data.source === 'local')
    } catch (e) {
      console.error('Failed to load business objects:', e)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(`Delete business object "${id}"?`)) {
      return
    }

    try {
      await deleteContract(project, id)

      setActors(actors.filter((a) => a.id !== id))
    } catch (e) {
      alert('Failed to delete aggregate')
    }
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center py-12 text-sm">
        Loading business objects...
      </div>
    )
  }

  return (
    <section className="build-workspace">
      <div className="build-workspace__header">
        <div className="workspace-panel__title">
          <p className="workspace-kicker">Architecture</p>
          <div className="flex items-center gap-2 mb-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Design your domain</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Each aggregate owns its data, commands, and lifecycle. Start with the boundary that matters most to the business.
          </p>
        </div>

        <div className="workspace-panel__actions">
          <Button
            size="default"
            className="button-primary"
            onClick={onAIBuilder}
          >
            <Sparkles className="size-3.5" />
            <span>Generate from brief</span>
          </Button>
          <Button
            variant="outline"
            size="default"
            className="button-secondary"
            onClick={onAddBusinessObject}
          >
            <Plus className="size-3.5" />
            <span>Add business object</span>
          </Button>
        </div>
      </div>

      {isLocalWorkspace && (
        <p className="local-workspace-notice" role="status">
          Local Workspace — changes are saved in this browser until a Control API is connected.
        </p>
      )}

      <div className="build-workspace__body">
        <section className="aggregate-list" aria-label="Business aggregates">
          <div className="aggregate-list__header"><div><h3>Aggregates</h3><p>{actors.length} defined in this project</p></div><span>Ownership boundary</span></div>
          <div className="actors-grid">{actors.map((actor) => <ActorCard key={actor.id} actor={actor} onClick={() => onActorClick(actor)} onDelete={() => handleDelete(actor.id)} />)}</div>
          {actors.length === 0 && <div className="build-empty"><Server className="size-6" /><div><h3>No aggregate yet</h3><p>Define the first business boundary for this project.</p></div><Button onClick={onAddBusinessObject}><Plus className="size-4" />Create aggregate</Button></div>}
        </section>
        <aside className="build-next-step">
          <p className="workspace-kicker">Next step</p>
          <h3>{actors.length ? 'Review an aggregate' : 'Create your first aggregate'}</h3>
          <p>{actors.length ? 'Open an aggregate to define its objects, commands, and lifecycle transitions.' : 'Start with a single business responsibility, such as an order or appointment.'}</p>
          <Button variant="outline" size="sm" onClick={onAddBusinessObject}><Plus className="size-3.5" /> New aggregate</Button>
          <div className="build-next-step__rule"><ArrowRight className="size-3.5" /> Releases remain unavailable until the Control API validates an immutable contract.</div>
        </aside>
      </div>

    </section>
  )
}
