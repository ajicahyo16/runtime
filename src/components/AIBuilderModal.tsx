import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface AIBuilderModalProps {
  isOpen: boolean
  onClose: () => void
  onGenerateProposal: (proposal: {
    name: string
    id: string
    objects: Array<{ name: string; fields: string }> | string[]
    actions: string[]
    states: Array<{ obj: string; flow: string[] }> | string[]
  }) => void
}

export function AIBuilderModal({ isOpen, onClose, onGenerateProposal }: AIBuilderModalProps) {
  const [prompt, setPrompt] = useState('')

  if (!isOpen) return null

  const handleGenerate = () => {
    const promptText = prompt.trim()
    if (!promptText) {
      alert('Please describe your business model prompt first.')
      return
    }

    // Default proposal
    let aggregateName = 'Inventory POS System'
    let objList = [
      { name: 'StockItem', fields: 'id, sku, name, quantity' },
      { name: 'Product', fields: 'id, name, price' },
      { name: 'Order', fields: 'id, status, total' },
      { name: 'Receipt', fields: 'id, paymentMethod, amount' }
    ]
    let actionList = ['AdjustStock', 'SellProduct', 'LogReceipt']
    let stateList = [
      { obj: 'Order', flow: ['Draft', 'Processed', 'Synced'] }
    ]

    const lowerPrompt = promptText.toLowerCase()
    if (lowerPrompt.includes('klinik') || lowerPrompt.includes('clinic')) {
      aggregateName = 'Clinic Booking Calendar'
      objList = [
        { name: 'Patient', fields: 'id, name, phone, medicalHistory' },
        { name: 'Appointment', fields: 'id, dateTime, status' },
        { name: 'DoctorSchedule', fields: 'id, doctorName, slots' },
        { name: 'Prescription', fields: 'id, medicine, dosage' }
      ]
      actionList = ['BookAppointment', 'CheckInPatient', 'WritePrescription']
      stateList = [
        { obj: 'Appointment', flow: ['Scheduled', 'Arrived', 'CheckedOut', 'NoShow'] }
      ]
    } else if (lowerPrompt.includes('finance') || lowerPrompt.includes('accounting') || lowerPrompt.includes('billing')) {
      aggregateName = 'Billing Operations Ledger'
      objList = [
        { name: 'Invoice', fields: 'id, amount, dueDate, status' },
        { name: 'PaymentReceived', fields: 'id, paymentDate, amount' },
        { name: 'TaxRecord', fields: 'id, taxRate, amount' },
        { name: 'LedgerEntry', fields: 'id, type, amount' }
      ]
      actionList = ['CreateInvoice', 'ApplyPayment', 'GenerateTaxSummary']
      stateList = [
        { obj: 'Invoice', flow: ['Unpaid', 'PartiallyPaid', 'Paid', 'Overdue'] }
      ]
    }

    onGenerateProposal({
      name: aggregateName,
      id: aggregateName.toLowerCase().replace(/\s+/g, '-'),
      objects: objList,
      actions: actionList,
      states: stateList
    })
    
    setPrompt('')
  }

  return (
    <div
      className="modal-overlay-blur"
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
      <div
        className="modal-content-glass glass-card"
        style={{ width: '520px', padding: '2rem', position: 'relative' }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '1rem',
            right: '1rem',
            background: 'transparent',
            border: 'none',
            color: '#64748b',
            fontSize: '1.2rem',
            cursor: 'pointer',
          }}
        >
          <X className="size-5" />
        </button>

        <div className="panel-header" style={{ marginBottom: '1rem' }}>
          <Sparkles
            className="panel-icon"
            style={{ width: '24px', height: '24px', color: '#ec4899' }}
          />
          <h2 style={{ fontSize: '1.2rem', margin: 0, color: '#fff' }}>AI App Builder</h2>
        </div>
        <p className="panel-desc" style={{ fontSize: '0.85rem', color: '#cbd5e1', marginBottom: '1.5rem' }}>
          Describe your business workflow. AI will propose business objects, commands, and states ready to review.
        </p>

        <div className="prompt-box-wrapper">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="e.g. Buatkan POS restoran dengan dine-in, takeaway, shifts kasir, discount, dan reports harian..."
            style={{
              width: '100%',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.88rem',
              padding: '0.75rem',
              resize: 'vertical',
              marginBottom: '1rem',
              lineHeight: 1.5,
            }}
          />
          <Button
            onClick={handleGenerate}
            className="w-full"
          >
            <span>Generate Model Proposal</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
