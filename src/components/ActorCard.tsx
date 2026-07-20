import { Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
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
    <Card
      className="actor-card relative cursor-pointer transition-all flex flex-col justify-between h-full"
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

      <div className="actor-info flex-1 pr-7">
        <h4 className="text-base font-semibold truncate text-foreground">{actor.name}</h4>
        <div className="actor-meta flex flex-col gap-1 text-xs text-muted-foreground mt-2">
          <span>Business object · Durable Object / SQLite</span>
          <span>Size: {actor.size}</span>
          <span>Queries: {actor.queries.toLocaleString()}</span>
        </div>
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
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
    </Card>
  )
}
