import { Button } from '@/components/ui/button'
import { Check } from 'lucide-react'

interface Proposal {
  name: string
  id: string
  objects: Array<{ name: string; fields: string }>
  actions: string[]
  states: Array<{ obj: string; flow: string[] }>
}

interface AIProposalModalProps {
  isOpen: boolean
  proposal: Proposal | null
  onReject: () => void
  onAccept: () => void
}

export function AIProposalModal({ isOpen, proposal, onReject, onAccept }: AIProposalModalProps) {
  if (!isOpen || !proposal) return null

  return (
    <div
      className="modal-overlay"
      style={{
        display: 'flex',
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(8px)',
        zIndex: 1010,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div className="glass-card modal-content" style={{ width: '520px', padding: '2rem' }}>
        <div className="panel-header" style={{ marginBottom: '1rem' }}>
          <Check
            className="panel-icon"
            style={{ width: '24px', height: '24px', color: '#22c55e' }}
          />
          <h2 style={{ fontSize: '1.2rem', margin: 0, color: '#fff' }}>AI Model Proposal</h2>
        </div>
        <p className="panel-desc" style={{ fontSize: '0.85rem', color: '#cbd5e1', marginBottom: '1.5rem' }}>
          AI generated a business spec from your prompt. Review the architecture before compiling.
        </p>

        <div className="proposal-details" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem', maxHeight: '350px', overflowY: 'auto', paddingRight: '0.5rem' }}>
          <div className="proposal-section" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '0.75rem' }}>
            <h4 style={{ margin: '0 0 0.4rem 0', fontSize: '0.9rem', color: '#cbd5e1', fontWeight: 600 }}>Proposed Business Aggregate</h4>
            <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8' }}>
              <strong>{proposal.name}</strong> (Mapped internally to <code>Durable Object</code> and <code>SQLite</code>)
            </p>
          </div>
          
          <div className="proposal-section" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '0.75rem' }}>
            <h4 style={{ margin: '0 0 0.4rem 0', fontSize: '0.9rem', color: '#cbd5e1', fontWeight: 600 }}>Proposed Business Objects</h4>
            <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.85rem', color: '#94a3b8' }}>
              {proposal.objects.map((o) => (
                <li key={o.name}>{o.name} <span style={{ opacity: 0.6, fontSize: '0.75rem' }}>({o.fields})</span></li>
              ))}
            </ul>
          </div>

          <div className="proposal-section" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '0.75rem' }}>
            <h4 style={{ margin: '0 0 0.4rem 0', fontSize: '0.9rem', color: '#cbd5e1', fontWeight: 600 }}>Proposed Allowed Actions</h4>
            <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.85rem', color: '#94a3b8' }}>
              {proposal.actions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>

          <div className="proposal-section" style={{ paddingBottom: '0.25rem' }}>
            <h4 style={{ margin: '0 0 0.4rem 0', fontSize: '0.9rem', color: '#cbd5e1', fontWeight: 600 }}>Proposed State Machine</h4>
            <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.85rem', color: '#94a3b8' }}>
              {proposal.states.map((s) => (
                <li key={s.obj}>
                  <strong>{s.obj}</strong>: {s.flow.join(' → ')}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="modal-actions" style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '1rem' }}>
          <Button variant="outline" onClick={onReject}>
            Reject Spec
          </Button>
          <Button onClick={onAccept}>
            Approve & Compile
          </Button>
        </div>
      </div>
    </div>
  )
}
