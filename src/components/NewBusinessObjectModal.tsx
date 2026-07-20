import { useState } from 'react'
import { Boxes, Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface NewBusinessObjectModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string) => Promise<void>
}

export function NewBusinessObjectModal({ isOpen, onClose, onCreate }: NewBusinessObjectModalProps) {
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')

  if (!isOpen) return null

  const objectId = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (name.trim().length < 2 || !objectId) {
      setError('Enter a business object name using letters or numbers.')
      return
    }

    setIsCreating(true)
    setError('')
    try {
      await onCreate(name.trim())
      setName('')
      onClose()
    } catch (reason: any) {
      setError(reason.message || 'Business object could not be created.')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="project-modal-overlay" role="presentation">
      <form className="project-modal business-object-modal" onSubmit={submit}>
        <button type="button" className="project-modal__close" onClick={onClose} aria-label="Close new business object dialog">
          <X className="size-4" />
        </button>
        <div className="project-modal__heading">
          <span className="section-icon"><Boxes className="size-5" /></span>
          <div><h2>New business object</h2><p>Start with a focused data boundary, then add actions and lifecycle states.</p></div>
        </div>
        <label className="project-field">Business object name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Customer Order" autoFocus />
          <small>{objectId ? `Object ID: ${objectId}` : 'A lowercase object ID will be generated automatically.'}</small>
        </label>
        {error && <p className="project-modal__error">{error}</p>}
        <div className="project-modal__footer">
          <span>It starts with a Record object, two commands, and a simple lifecycle that you can edit next.</span>
          <Button type="submit" disabled={isCreating}>
            {isCreating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {isCreating ? 'Creating…' : 'Create object'}
          </Button>
        </div>
      </form>
    </div>
  )
}
