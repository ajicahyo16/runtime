import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface Actor {
  id: string
  name: string
  aggregateType?: string
  key?: string
  size: string
  queries: number
  status: 'active' | 'dormant' | 'error'
  objects?: Array<{ name: string; fields?: string }>
  actions?: string[]
  states?: Array<{ obj: string; flow: string[] }>
}

interface ActorCardProps {
  actor: Actor
  onClick: () => void
  onDelete: () => void
}

export function ActorCard({ actor, onClick, onDelete }: ActorCardProps) {
  return (
    <article
      className="actor-card"
      onClick={onClick}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-4 right-4 z-10 text-muted-foreground hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        <Trash2 className="size-4" />
      </Button>

      <div className="actor-info">
        <div><p className="actor-card__type">{actor.aggregateType || 'Business aggregate'}</p><h4>{actor.name}</h4></div>
        <div className="actor-meta flex flex-col gap-1 text-xs text-muted-foreground mt-2">
          <span>{actor.aggregateType || 'Business aggregate'} · partition key: <code>{actor.key || 'id'}</code></span>
          <span>{actor.objects?.length || 0} objects · {actor.actions?.length || 0} commands · {actor.states?.length || 0} state machines</span>
        </div>
      </div>

      <div className="actor-card__footer">
        <span
          className={cn(
            'actor-badge inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase',
            {
              'bg-primary/10 text-primary': actor.status === 'active',
              'bg-muted text-muted-foreground': actor.status === 'dormant',
              'bg-destructive/10 text-destructive': actor.status === 'error',
            }
          )}
        >
          {actor.status}
        </span>
      </div>
    </article>
  )
}
