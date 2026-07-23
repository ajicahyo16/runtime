import { useEffect, useRef, useState } from 'react'
import { Activity, Circle, Database, Pause, Play, Send, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Actor } from '@/components/ActorCard'

interface GraphNode {
  id: string
  label: string
  type: 'gateway' | 'actor' | 'storage'
  x: number
  y: number
  color: string
}

interface FlowParticle {
  points: Array<{ x: number; y: number }>
  segment: number
  progress: number
  color: string
}

interface LiveEvent {
  id: number
  actorId: string
  actorName: string
  action: string
  time: string
  detail: string
}

const actorColors = ['#22c55e', '#38bdf8', '#a855f7', '#f59e0b', '#f43f5e', '#14b8a6']

export function UniverseView({ project }: { project: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<GraphNode[]>([])
  const [actors, setActors] = useState<Actor[]>([])
  const [selectedActorId, setSelectedActorId] = useState('')
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [isLive, setIsLive] = useState(true)

  useEffect(() => {
    fetch(`/api/load-contracts?project=${project}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.actors) return
        setActors(data.actors)
        setSelectedActorId(data.actors[0]?.id || '')
      })
      .catch(() => undefined)
  }, [project])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    let frameId = 0
    let intervalId: number | undefined
    const particles: FlowParticle[] = []
    const visibleActors = actors.slice(0, 6)

    const updateSize = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const ratio = window.devicePixelRatio || 1
      canvas.width = parent.clientWidth * ratio
      canvas.height = 420 * ratio
      canvas.style.height = '420px'
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      layoutNodes(parent.clientWidth, 420)
    }

    const layoutNodes = (width: number, height: number) => {
      const center = width / 2
      const actorY = height * 0.52
      const step = width / (visibleActors.length + 1 || 2)
      nodesRef.current = [
        { id: 'gateway', label: 'Edge Gateway', type: 'gateway', x: center, y: 66, color: '#38bdf8' },
        ...visibleActors.map((actor, index) => ({
          id: actor.id,
          label: actor.name,
          type: 'actor' as const,
          x: step * (index + 1),
          y: actorY,
          color: actorColors[index % actorColors.length],
        })),
        { id: 'sqlite', label: 'SQLite Persistence', type: 'storage', x: center, y: height - 64, color: '#a855f7' },
      ]
    }

    const addParticle = (actorId: string) => {
      const gateway = nodesRef.current.find((node) => node.id === 'gateway')
      const actor = nodesRef.current.find((node) => node.id === actorId)
      const storage = nodesRef.current.find((node) => node.id === 'sqlite')
      if (!gateway || !actor || !storage) return
      particles.push({
        points: [{ x: gateway.x, y: gateway.y }, { x: actor.x, y: actor.y }, { x: storage.x, y: storage.y }],
        segment: 0,
        progress: 0,
        color: actor.color,
      })
    }

    const eventHandler = (event: Event) => addParticle((event as CustomEvent<string>).detail)
    window.addEventListener('universe:transaction', eventHandler)
    updateSize()
    window.addEventListener('resize', updateSize)

    const draw = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const isDark = document.documentElement.classList.contains('dark')
      context.clearRect(0, 0, width, height)
      const allNodes = nodesRef.current
      const gateway = allNodes.find((node) => node.id === 'gateway')
      const storage = allNodes.find((node) => node.id === 'sqlite')
      const actorNodes = allNodes.filter((node) => node.type === 'actor')

      actorNodes.forEach((actor) => {
        if (!gateway || !storage) return
        context.strokeStyle = isDark ? 'rgba(161, 161, 170, 0.22)' : 'rgba(113, 113, 122, 0.26)'
        context.lineWidth = 1
        context.setLineDash([4, 6])
        context.beginPath()
        context.moveTo(gateway.x, gateway.y)
        context.lineTo(actor.x, actor.y)
        context.lineTo(storage.x, storage.y)
        context.stroke()
        context.setLineDash([])
      })

      for (let index = particles.length - 1; index >= 0; index--) {
        const particle = particles[index]
        particle.progress += 0.026
        if (particle.progress >= 1) {
          particle.segment += 1
          particle.progress = 0
        }
        if (particle.segment >= particle.points.length - 1) {
          particles.splice(index, 1)
          continue
        }
        const from = particle.points[particle.segment]
        const to = particle.points[particle.segment + 1]
        const x = from.x + (to.x - from.x) * particle.progress
        const y = from.y + (to.y - from.y) * particle.progress
        context.beginPath()
        context.arc(x, y, 4, 0, Math.PI * 2)
        context.fillStyle = particle.color
        context.shadowColor = particle.color
        context.shadowBlur = 12
        context.fill()
        context.shadowBlur = 0
      }

      allNodes.forEach((node) => {
        const selected = node.id === selectedActorId
        context.beginPath()
        context.arc(node.x, node.y, selected ? 25 : 20, 0, Math.PI * 2)
        context.fillStyle = `${node.color}${selected ? '28' : '16'}`
        context.fill()
        context.beginPath()
        context.arc(node.x, node.y, selected ? 11 : 9, 0, Math.PI * 2)
        context.fillStyle = node.color
        context.fill()
        context.font = '600 11px Geist Mono, monospace'
        context.fillStyle = isDark ? '#e4e4e7' : '#27272a'
        context.textAlign = 'center'
        context.fillText(node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label, node.x, node.y + 38)
      })
      frameId = requestAnimationFrame(draw)
    }

    const handleCanvasClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const clickedActor = nodesRef.current.find((node) => node.type === 'actor' && Math.hypot(node.x - x, node.y - y) < 28)
      if (clickedActor) setSelectedActorId(clickedActor.id)
    }
    canvas.addEventListener('click', handleCanvasClick)

    if (isLive && visibleActors.length) {
      intervalId = window.setInterval(() => addParticle(visibleActors[Math.floor(Math.random() * visibleActors.length)].id), 1700)
    }
    draw()
    return () => {
      cancelAnimationFrame(frameId)
      if (intervalId) window.clearInterval(intervalId)
      window.removeEventListener('resize', updateSize)
      window.removeEventListener('universe:transaction', eventHandler)
      canvas.removeEventListener('click', handleCanvasClick)
    }
  }, [actors, isLive, selectedActorId])

  const selectedActor = actors.find((actor) => actor.id === selectedActorId)

  const triggerTransaction = () => {
    const actor = selectedActor || actors[0]
    if (!actor) return
    const action = actor.actions?.[0] || 'ExecuteCommand'
    const event: LiveEvent = {
      id: Date.now(),
      actorId: actor.id,
      actorName: actor.name,
      action,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      detail: `${action} persisted to ${actor.key || 'id'} partition via SQLite.`,
    }
    setEvents((current) => [event, ...current].slice(0, 5))
    window.dispatchEvent(new CustomEvent('universe:transaction', { detail: actor.id }))
  }

  return (
    <section className="glass-card universe-panel">
      <div className="universe-panel__header">
        <div>
          <div className="panel-header flex items-center gap-2 mb-1.5">
            <span className="section-icon"><Circle className="size-4" /></span>
          <h2 className="text-lg font-bold m-0">Topology preview</h2>
          </div>
          <p className="panel-desc text-xs text-muted-foreground mb-0">
            Inspect how configured aggregates route through the runtime. This is a local architecture preview.
          </p>
        </div>
        <div className="universe-panel__controls">
          <label className="sr-only" htmlFor="graph-actor">Selected aggregate</label>
          <select id="graph-actor" className="universe-select" value={selectedActorId} onChange={(event) => setSelectedActorId(event.target.value)}>
            {actors.length ? actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name}</option>) : <option value="">No aggregate available</option>}
          </select>
          <Button variant="outline" size="sm" onClick={() => setIsLive((current) => !current)}>
            {isLive ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {isLive ? 'Pause animation' : 'Resume animation'}
          </Button>
          <Button size="sm" onClick={triggerTransaction} disabled={!actors.length}>
            <Send className="size-3.5" />
            Animate route
          </Button>
        </div>
      </div>

      <div className="universe-canvas-shell">
        <canvas ref={canvasRef} className="universe-canvas" aria-label="Live transaction graph. Click an aggregate node to inspect it." />
        <div className="universe-legend">
          <span><i className="legend-dot legend-dot--gateway" />Gateway</span>
          <span><i className="legend-dot legend-dot--actor" />Aggregate</span>
          <span><i className="legend-dot legend-dot--storage" />SQLite</span>
        </div>
      </div>

      <div className="universe-details-grid">
        <div className="universe-selection">
          <span className="universe-eyebrow">Selected aggregate</span>
          <strong>{selectedActor?.name || 'No aggregate selected'}</strong>
          <p>{selectedActor ? `${selectedActor.aggregateType || 'Business'} · partition key: ${selectedActor.key || 'id'}` : 'Create an aggregate in Build to populate this flow.'}</p>
          <span className="universe-state"><Database className="size-3.5" /> SQLite persistence ready</span>
        </div>
        <div className="universe-event-feed">
          <div className="universe-event-feed__title"><Activity className="size-4" /> Preview activity</div>
          {events.length ? events.map((event) => (
            <button key={event.id} className="universe-event" onClick={() => setSelectedActorId(event.actorId)}>
              <span><b>{event.actorName}</b> · {event.action}</span><time>{event.time}</time>
              <small>{event.detail}</small>
            </button>
          )) : <div className="universe-empty"><Zap className="size-4" /> Run a transaction to inspect its path.</div>}
        </div>
      </div>
    </section>
  )
}
