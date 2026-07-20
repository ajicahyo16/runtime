import { useEffect, useState } from 'react'
import { Server, Sparkles, Plus } from 'lucide-react'
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
    <section className="glass-card panel-vaults workspace-panel">
      {/* Header Section */}
      <div className="workspace-panel__header">
        <div className="workspace-panel__title">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="section-icon"><Server className="size-4" /></span>
            <h2 className="text-xl font-bold tracking-tight">Business Objects</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Model the data and actions your business needs. Each object runs in an isolated Durable Object boundary.
          </p>
        </div>

        <div className="workspace-panel__actions">
          <Button
            size="default"
            className="button-primary"
            onClick={onAIBuilder}
          >
            <Sparkles className="size-3.5" />
            <span>AI App Builder</span>
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

      {/* Business object cards */}
      <div className="actors-grid">
        {actors.map((actor) => (
          <ActorCard
            key={actor.id}
            actor={actor}
            onClick={() => onActorClick(actor)}
            onDelete={() => handleDelete(actor.id)}
          />
        ))}
      </div>

      {actors.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-12 text-sm border border-dashed border-white/10 rounded-xl mb-8">
          <Server className="size-8 opacity-50" />
          <p>No business objects yet.</p>
          <Button onClick={onAddBusinessObject}>
            <Plus className="size-4" />
            Create your first object
          </Button>
        </div>
      )}

    </section>
  )
}
