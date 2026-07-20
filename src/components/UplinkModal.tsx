import React, { useState, useEffect } from 'react'
import { Cloud, Eye, EyeOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface UplinkModalProps {
  isOpen: boolean
  onClose: () => void
  onConnectionSuccess: (isConnected: boolean, accountName?: string) => void
  currentEnv: string
}

export function UplinkModal({ isOpen, onClose, onConnectionSuccess, currentEnv }: UplinkModalProps) {
  const [accountId, setAccountId] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [statusText, setStatusText] = useState('Uplink: Off')
  const [statusColor, setStatusColor] = useState('#64748b')
  const [isConnected, setIsConnected] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  useEffect(() => {
    if (isOpen) {
      // Sync initial state from legacy/window global if present
      const globalState = (window as any).STATE
      if (globalState) {
        setIsConnected(globalState.isUplinkConnected)
        if (globalState.isUplinkConnected) {
          setStatusText(`Uplink Status: Connected (${currentEnv.toUpperCase()})`)
          setStatusColor('#10b981')
        }
      }
      fetch('/api/uplink-session')
        .then((response) => response.ok ? response.json() : null)
        .then((session) => {
          if (!session?.connected) return
          setIsConnected(true)
          setStatusText(`Uplink Status: Connected (${currentEnv.toUpperCase()}) [${session.accountName}]`)
          setStatusColor('#10b981')
        })
        .catch(() => undefined)
    }
  }, [isOpen, currentEnv])

  if (!isOpen) return null

  const logMessage = (text: string, type: string = '') => {
    if (typeof (window as any).addLog === 'function') {
      ;(window as any).addLog(text, type)
    } else {
      console.log(`[Log] ${type.toUpperCase()}: ${text}`)
    }
  }

  const handleSuccessConnection = (accountName: string = 'sandbox') => {
    setIsConnected(true)
    setIsConnecting(false)
    setIsAnimating(false)
    setStatusText(`Uplink Status: Connected (${currentEnv.toUpperCase()}) [${accountName}]`)
    setStatusColor('#10b981')

    // Update global state
    if ((window as any).STATE) {
      ;(window as any).STATE.isUplinkConnected = true
    }

    onConnectionSuccess(true, accountName)

    // Call legacy function checkUserSpaceStatus if it exists
    if (typeof (window as any).checkUserSpaceStatus === 'function') {
      ;(window as any).checkUserSpaceStatus()
    }

    // Auto-close modal after delay
    setTimeout(() => {
      onClose()
    }, 1200)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsConnecting(true)
    setIsAnimating(true)
    setStatusText('Performing secure handshake...')
    setStatusColor('#f59e0b')
    logMessage('[Uplink] Authenticating credentials with Cloudflare edge...', 'warn')

    if (apiToken === 'sandbox' || apiToken === 'mock') {
      setTimeout(() => {
        handleSuccessConnection()
        logMessage('[Uplink] Sandbox mode loaded. Mock access active for DO/R2/SQLite.', 'success')
      }, 1500)
      return
    }

    try {
      const response = await fetch('/api/verify-uplink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, apiToken }),
      })
      const data = await response.json()

      if (response.ok && data.success) {
        const accountName = data.message.replace('Linked to account: ', '')
        handleSuccessConnection(accountName)
        logMessage(`[Uplink] Secure uplink established. Linked to Account: ${accountName}`, 'success')
      } else {
        throw new Error(data.message || 'Verification failed.')
      }
    } catch (err: any) {
      setIsConnecting(false)
      setIsAnimating(false)
      setStatusText('Uplink: Failed')
      setStatusColor('#ef4444')
      logMessage(`[Uplink] Handshake failed: ${err.message}`, 'error')
      alert(`Handshake failed: ${err.message}`)
    }
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
        style={{ width: '480px', padding: '2rem', position: 'relative' }}
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
          <Cloud
            className="panel-icon"
            style={{ width: '24px', height: '24px', color: '#38bdf8' }}
          />
          <h2 style={{ fontSize: '1.2rem', margin: 0, color: '#fff' }}>Cloudflare Uplink</h2>
        </div>
        <p className="panel-desc" style={{ fontSize: '0.85rem', color: '#cbd5e1', marginBottom: '1.5rem' }}>
          Configure endpoints and authenticate connection keys.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
          <div className="input-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <label htmlFor="accountId" style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase' }}>
              Account ID
            </label>
            <input
              type="text"
              id="accountId"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="Enter Cloudflare Account ID"
              required
              autoComplete="off"
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px',
                padding: '0.6rem',
                color: '#fff',
                fontSize: '0.85rem',
                width: '100%',
              }}
            />
          </div>

          <div className="input-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <label htmlFor="apiToken" style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase' }}>
              API Token
            </label>
            <div className="password-wrapper" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                type={showToken ? 'text' : 'password'}
                id="apiToken"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Enter API Token (type 'sandbox' for mock)"
                required
                autoComplete="off"
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '8px',
                  padding: '0.6rem 2.5rem 0.6rem 0.6rem',
                  color: '#fff',
                  fontSize: '0.85rem',
                  width: '100%',
                }}
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                style={{
                  position: 'absolute',
                  right: '0.75rem',
                  background: 'transparent',
                  border: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <Button
            type="submit"
            disabled={isConnecting}
            className="w-full mt-2"
          >
            <span>{isConnecting ? 'Connecting Handshake...' : 'Establish Secure Uplink'}</span>
          </Button>
        </form>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid rgba(255,255,255,0.05)',
            paddingTop: '1.5rem',
            marginTop: '1.5rem',
          }}
        >
          <div
            className={`uplink-status-container ${isAnimating ? 'animating' : ''}`}
            style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1 }}
          >
            <div className="node local-node active" style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', borderRadius: '4px' }}>
              Console
            </div>
            <div className="connector-line" style={{ width: '50px', height: '2px', background: 'rgba(255,255,255,0.1)', position: 'relative' }}>
              <div
                className="pulse-particle"
                style={{
                  width: '6px',
                  height: '6px',
                  background: '#38bdf8',
                  borderRadius: '50%',
                  position: 'absolute',
                  top: '-2px',
                  left: 0,
                  animation: 'pulseFlow 1.5s infinite linear',
                }}
              />
            </div>
            <div
              className={`node cloud-node ${isConnected ? 'connected' : ''}`}
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', borderRadius: '4px' }}
            >
              Cloudflare
            </div>
          </div>
          <div
            className="status-message"
            style={{
              fontSize: '0.8rem',
              color: statusColor,
              fontWeight: 600,
              textAlign: 'right',
              margin: 0,
            }}
          >
            {statusText}
          </div>
        </div>
      </div>
    </div>
  )
}
