import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Clipboard, Code2, KeyRound, RefreshCw, ShieldCheck, Terminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Environment = 'dev' | 'staging' | 'production'

interface OperationCapability {
  actor: string
  operation: string
  kind: 'command' | 'query'
}

interface RuntimeCredential {
  id: string
  name: string
  environment: Environment
  capabilities: Array<{
    actor: string
    operations: string[]
    rateLimitPerMinute: number
    maxPayloadBytes: number
  }>
  expiresAt: number
  revokedAt: number | null
  createdAt: number
}

interface ContractOperation {
  definition?: { name?: string; kind?: 'command' | 'query' }
}

interface Contract {
  aggregateType?: string
  operations?: ContractOperation[]
}

export function RuntimeAccessView({ project, onOpenReleases }: { project: string; onOpenReleases: () => void }) {
  const [credentials, setCredentials] = useState<RuntimeCredential[]>([])
  const [operations, setOperations] = useState<OperationCapability[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [name, setName] = useState('Personal backend')
  const [environment, setEnvironment] = useState<Environment>('dev')
  const [expiresInDays, setExpiresInDays] = useState(90)
  const [rateLimit, setRateLimit] = useState(60)
  const [maxPayloadBytes, setMaxPayloadBytes] = useState(32_768)
  const [oneTimeToken, setOneTimeToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [credentialResponse, contractResponse] = await Promise.all([
      fetch(`/api/projects/${encodeURIComponent(project)}/runtime-credentials`),
      fetch(`/api/projects/${encodeURIComponent(project)}/contracts`),
    ])
    const [credentialData, contractData] = await Promise.all([
      credentialResponse.json().catch(() => null),
      contractResponse.json().catch(() => null),
    ])
    if (!credentialResponse.ok) throw new Error(credentialData?.message || 'Runtime credentials could not be loaded.')
    if (!contractResponse.ok) throw new Error(contractData?.message || 'Operation contracts could not be loaded.')
    setCredentials(credentialData?.credentials || [])
    const available = (contractData?.contracts || []).flatMap((contract: Contract) =>
      (contract.operations || []).flatMap((operation) => {
        const actor = contract.aggregateType
        const operationName = operation.definition?.name
        const kind = operation.definition?.kind
        return actor && operationName && kind ? [{ actor, operation: operationName, kind }] : []
      }),
    )
    setOperations(available)
  }, [project])

  useEffect(() => {
    setOneTimeToken('')
    setSelected(new Set())
    setMessage('')
    void load().catch((error) => setMessage(error instanceof Error ? error.message : 'Runtime access could not be loaded.'))
  }, [load])

  const grouped = useMemo(() => {
    const actors = new Map<string, OperationCapability[]>()
    for (const operation of operations) actors.set(operation.actor, [...(actors.get(operation.actor) || []), operation])
    return [...actors.entries()]
  }, [operations])

  function toggle(actor: string, operation: string) {
    const key = `${actor}:${operation}`
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function createCredential() {
    const capabilities = grouped.flatMap(([actor, actorOperations]) => {
      const allowed = actorOperations.filter(({ operation }) => selected.has(`${actor}:${operation}`)).map(({ operation }) => operation)
      return allowed.length ? [{ actor, operations: allowed, rateLimitPerMinute: rateLimit, maxPayloadBytes }] : []
    })
    if (!capabilities.length) { setMessage('Select at least one operation.'); return }
    setBusy(true); setMessage(''); setOneTimeToken('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/runtime-credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, environment, expiresInDays, capabilities }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.message || 'Runtime credential could not be created.')
      setOneTimeToken(data.credential.token)
      setMessage('Credential created. Copy it now, then redeploy this environment from Releases.')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Runtime credential could not be created.')
    } finally { setBusy(false) }
  }

  async function revokeCredential(id: string) {
    if (!window.confirm('Revoke this credential? Redeploy the environment afterward to remove it from the immutable runtime policy.')) return
    setBusy(true); setMessage('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/runtime-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.message || 'Runtime credential could not be revoked.')
      setMessage('Credential revoked. Redeploy its environment from Releases.')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Runtime credential could not be revoked.')
    } finally { setBusy(false) }
  }

  async function copyToken() {
    await navigator.clipboard.writeText(oneTimeToken)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2_000)
  }

  const activeCredentials = credentials.filter((credential) => !credential.revokedAt && credential.expiresAt > Date.now())

  return <div className="runtime-access-view">
    <section className="runtime-access-hero">
      <div>
        <span className="runtime-access-eyebrow"><ShieldCheck className="size-4" /> Server-side application access</span>
        <h1>Connect your project without exposing the database.</h1>
        <p>Select only the operations your backend needs. Lacify stores a token hash, enforces Actor capabilities, and keeps business payloads out of audit and telemetry.</p>
      </div>
      <div className="runtime-access-score">
        <strong>{activeCredentials.length}</strong>
        <span>active credential{activeCredentials.length === 1 ? '' : 's'}</span>
      </div>
    </section>

    {message && <div className="workspace-settings-message" role="status">{message}</div>}

    <section className="runtime-access-layout">
      <article className="glass-card runtime-access-card runtime-access-create">
        <header><KeyRound className="size-5" /><div><h2>Create scoped credential</h2><p>The plaintext token is returned once.</p></div></header>
        <div className="runtime-access-form-grid">
          <label>Name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
          <label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value as Environment)}><option value="dev">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label>
          <label>Expires in days<input type="number" min="1" max="365" value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))} /></label>
          <label>Requests / minute<input type="number" min="1" max="10000" value={rateLimit} onChange={(event) => setRateLimit(Number(event.target.value))} /></label>
          <label>Maximum payload<select value={maxPayloadBytes} onChange={(event) => setMaxPayloadBytes(Number(event.target.value))}><option value={8192}>8 KiB</option><option value={32768}>32 KiB</option><option value={65536}>64 KiB</option></select></label>
        </div>
        <div className="runtime-operation-picker">
          <h3>Allowed operations</h3>
          {!grouped.length && <p>No executable operations are available. Add operation files through the Lacify CLI or MCP first.</p>}
          {grouped.map(([actor, actorOperations]) => <fieldset key={actor}>
            <legend>{actor}</legend>
            {actorOperations.map(({ operation, kind }) => {
              const key = `${actor}:${operation}`
              return <label key={key}><input type="checkbox" checked={selected.has(key)} onChange={() => toggle(actor, operation)} /><span><strong>{operation}</strong><small>{kind}</small></span></label>
            })}
          </fieldset>)}
        </div>
        <Button disabled={busy || !name.trim() || selected.size === 0} onClick={() => void createCredential()}><KeyRound className="size-4" /> Create credential</Button>
        {oneTimeToken && <div className="runtime-one-time-token">
          <div><strong>Copy this token now</strong><span>It will not be shown again.</span></div>
          <code>{oneTimeToken}</code>
          <Button variant="outline" onClick={() => void copyToken()}>{copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}{copied ? 'Copied' : 'Copy token'}</Button>
        </div>}
      </article>

      <aside className="runtime-access-side">
        <article className="glass-card runtime-access-card">
          <header><Terminal className="size-5" /><div><h2>AI/MCP setup</h2><p>Run MCP from the repository containing `lacify.runtime.yaml`.</p></div></header>
          <pre><code>{`LACIFY_RUNTIME_APPLICATION_TOKEN=•••••• \\\nnode /absolute/path/to/bin/lacify-mcp.mjs`}</code></pre>
          <p>Keep the token in your secret manager or MCP environment configuration—never in prompts.</p>
        </article>
        <article className="glass-card runtime-access-card">
          <header><Code2 className="size-5" /><div><h2>Generated SDK</h2><p>Use the credential only from a trusted backend.</p></div></header>
          <pre><code>{`const lacify = new LacifyClient(\n  process.env.LACIFY_RUNTIME_URL,\n  process.env.LACIFY_RUNTIME_TOKEN\n)`}</code></pre>
          <Button variant="outline" onClick={onOpenReleases}><RefreshCw className="size-4" /> Open Releases to redeploy</Button>
        </article>
      </aside>
    </section>

    <section className="glass-card runtime-access-card">
      <header><KeyRound className="size-5" /><div><h2>Credentials</h2><p>Values are never returned after creation. Policy changes activate on redeploy.</p></div></header>
      <div className="runtime-credential-list">
        {!credentials.length && <p>No credentials created for this project.</p>}
        {credentials.map((credential) => {
          const status = credential.revokedAt ? 'revoked' : credential.expiresAt <= Date.now() ? 'expired' : 'active'
          return <article key={credential.id}>
            <div>
              <strong>{credential.name}</strong>
              <span>{credential.environment} · {credential.capabilities.reduce((total, capability) => total + capability.operations.length, 0)} operation(s)</span>
            </div>
            <div className="runtime-credential-meta"><span className={`runtime-credential-status ${status}`}>{status}</span><time>{new Date(credential.expiresAt).toLocaleDateString()}</time></div>
            {!credential.revokedAt && <Button variant="outline" disabled={busy} onClick={() => void revokeCredential(credential.id)}><Trash2 className="size-4" /> Revoke</Button>}
          </article>
        })}
      </div>
    </section>
  </div>
}
