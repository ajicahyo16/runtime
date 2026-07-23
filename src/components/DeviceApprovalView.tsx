import { useState } from 'react'

interface DeviceApprovalViewProps {
  authenticated: boolean
  authenticationReady: boolean
}

export function DeviceApprovalView({ authenticated, authenticationReady }: DeviceApprovalViewProps) {
  const code = new URLSearchParams(window.location.search).get('code')?.toUpperCase() || ''
  const [status, setStatus] = useState<'idle' | 'approving' | 'approved' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function approve() {
    setStatus('approving')
    const response = await fetch('/api/cli/device/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: code }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      setMessage(data?.message || 'CLI access could not be approved.')
      setStatus('error')
      return
    }
    setMessage('CLI access approved. You can return to the terminal.')
    setStatus('approved')
  }

  return (
    <main className="min-h-screen bg-background text-foreground grid place-items-center p-6">
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-xl">
        <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Lacify CLI</div>
        <h1 className="mt-3 text-2xl font-semibold">Authorize this device</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This grants repository and Development workflow access for your current workspace. It does not expose Uplink credentials or secret values.
        </p>
        <div className="mt-6 rounded-lg border border-border bg-muted/40 px-4 py-3 font-mono text-xl tracking-[0.25em]">{code || 'INVALID'}</div>
        {!authenticationReady ? (
          <p className="mt-6 text-sm">Checking your application session…</p>
        ) : !authenticated ? (
          <p className="mt-6 text-sm">Sign in from the <a className="underline" href="/">Lacify console</a>, then reopen the verification link.</p>
        ) : (
          <button className="mt-6 w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={status === 'approving' || status === 'approved' || code.length !== 8} onClick={approve}>
            {status === 'approving' ? 'Approving…' : status === 'approved' ? 'Approved' : 'Approve CLI access'}
          </button>
        )}
        {message && <p className={`mt-4 text-sm ${status === 'error' ? 'text-destructive' : 'text-emerald-500'}`}>{message}</p>}
      </section>
    </main>
  )
}
