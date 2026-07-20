import { useState } from 'react'
import { Boxes, Check, FolderPlus, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Template = 'blank' | 'commerce' | 'inventory' | 'clinic' | 'billing'

const templates: Array<{ id: Template; title: string; description: string }> = [
  { id: 'blank', title: 'Blank project', description: 'Start with an empty Durable Object workspace.' },
  { id: 'commerce', title: 'Commerce', description: 'Seed an Order aggregate with checkout commands.' },
  { id: 'inventory', title: 'Inventory', description: 'Seed StockItem tracking and stock adjustments.' },
  { id: 'clinic', title: 'Clinic booking', description: 'Seed appointment scheduling and patient check-in.' },
  { id: 'billing', title: 'Billing', description: 'Seed invoices, payments, and ledger actions.' },
]

interface NewProjectModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string, template: Template) => Promise<void>
}

export function NewProjectModal({ isOpen, onClose, onCreate }: NewProjectModalProps) {
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<Template>('blank')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')

  if (!isOpen) return null

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!slug) {
      setError('Enter a project name using letters or numbers.')
      return
    }
    setIsCreating(true)
    setError('')
    try {
      await onCreate(slug, template)
      setName('')
      setTemplate('blank')
      onClose()
    } catch (reason: any) {
      setError(reason.message || 'Project could not be created.')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="project-modal-overlay" role="presentation">
      <form className="project-modal" onSubmit={submit}>
        <button type="button" className="project-modal__close" onClick={onClose} aria-label="Close new project dialog"><X className="size-4" /></button>
        <div className="project-modal__heading"><span className="section-icon"><FolderPlus className="size-5" /></span><div><h2>New project</h2><p>Create an isolated project boundary in your connected workspace.</p></div></div>
        <label className="project-field">Project name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. jakarta-retail" autoFocus />
          <small>{slug ? `Project ID: ${slug}` : 'Lowercase ID will be generated automatically.'}</small>
        </label>
        <div className="project-template-label"><Boxes className="size-4" /> Start from a template</div>
        <div className="project-template-grid">
          {templates.map((item) => <button key={item.id} type="button" className={`project-template ${template === item.id ? 'active' : ''}`} onClick={() => setTemplate(item.id)}>
            <span className="project-template__check">{template === item.id && <Check className="size-3" />}</span><strong>{item.title}</strong><small>{item.description}</small>
          </button>)}
        </div>
        {error && <p className="project-modal__error">{error}</p>}
        <div className="project-modal__footer"><span>Creates a local project now; deployment stays under your Uplink approval.</span><Button type="submit" disabled={isCreating}>{isCreating ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}{isCreating ? 'Creating…' : 'Create project'}</Button></div>
      </form>
    </div>
  )
}
