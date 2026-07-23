import { useCallback, useEffect, useState } from 'react'
import { ArchiveRestore, CheckCircle2, Clock3, KeyRound, ListChecks, RefreshCw, ShieldCheck, UserPlus, Users, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Role = 'owner' | 'admin' | 'developer' | 'operator' | 'viewer'
type Environment = 'dev' | 'staging' | 'production'

interface Member { id: string; display_name: string; role: Role; accountIdHint: string }
interface Invitation { id: string; role: Role; target_account_id?: string | null; expires_at: number; accepted_at?: number | null; revoked_at?: number | null }
interface EnvironmentState { variables: Record<string, string>; revision: number; secrets: Array<{ name: string; rotatedAt: number }> }
interface ReadinessCheck { id: string; label: string; passed: boolean }
interface Backup { id: string; provider: string; bookmark: string; verification_status: string; created_at: number }
interface OnboardingStep { step: string; completed_at: number }
interface GovernancePolicy { requireSeparateVerifier: boolean; requireSeparateApprover: boolean; requireSeparateDeployer: boolean; deploymentWindowStartHour: number | null; deploymentWindowEndHour: number | null }

const onboardingSteps = ['identity', 'uplink', 'project', 'contracts', 'environments', 'release', 'development', 'staging', 'production', 'recovery'] as const

export function WorkspaceSettingsView({ project }: { project: string }) {
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [environments, setEnvironments] = useState<Record<Environment, EnvironmentState> | null>(null)
  const [drift, setDrift] = useState<{ devToStaging: boolean; stagingToProduction: boolean } | null>(null)
  const [readiness, setReadiness] = useState<{ ready: boolean; checks: ReadinessCheck[] } | null>(null)
  const [backups, setBackups] = useState<Backup[]>([])
  const [onboarding, setOnboarding] = useState<OnboardingStep[]>([])
  const [governance, setGovernance] = useState<GovernancePolicy>({ requireSeparateVerifier: false, requireSeparateApprover: false, requireSeparateDeployer: false, deploymentWindowStartHour: null, deploymentWindowEndHour: null })
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('viewer')
  const [targetAccountId, setTargetAccountId] = useState('')
  const [invitationToken, setInvitationToken] = useState('')
  const [environment, setEnvironment] = useState<Environment>('dev')
  const [variables, setVariables] = useState('{}')
  const [secretName, setSecretName] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [memberResponse, invitationResponse, environmentResponse, readinessResponse, backupResponse, onboardingResponse, governanceResponse] = await Promise.all([
      fetch('/api/workspace/members'),
      fetch('/api/workspace/invitations'),
      fetch(`/api/projects/${encodeURIComponent(project)}/environments`),
      fetch(`/api/projects/${encodeURIComponent(project)}/readiness`),
      fetch('/api/backups'),
      fetch(`/api/projects/${encodeURIComponent(project)}/onboarding`),
      fetch('/api/workspace/governance'),
    ])
    const [memberData, invitationData, environmentData, readinessData, backupData, onboardingData, governanceData] = await Promise.all([
      memberResponse.json().catch(() => null), invitationResponse.json().catch(() => null), environmentResponse.json().catch(() => null),
      readinessResponse.json().catch(() => null), backupResponse.json().catch(() => null), onboardingResponse.json().catch(() => null),
      governanceResponse.json().catch(() => null),
    ])
    setMembers(memberResponse.ok ? memberData?.members || [] : [])
    setInvitations(invitationResponse.ok ? invitationData?.invitations || [] : [])
    setEnvironments(environmentResponse.ok ? environmentData?.environments : null)
    setDrift(environmentResponse.ok ? environmentData?.drift : null)
    setReadiness(readinessResponse.ok ? readinessData : null)
    setBackups(backupResponse.ok ? backupData?.backups || [] : [])
    setOnboarding(onboardingResponse.ok ? onboardingData?.progress || [] : [])
    if (governanceResponse.ok) {
      const policy = governanceData?.policy || {}
      setGovernance({
        requireSeparateVerifier: Boolean(policy.require_separate_verifier),
        requireSeparateApprover: Boolean(policy.require_separate_approver),
        requireSeparateDeployer: Boolean(policy.require_separate_deployer),
        deploymentWindowStartHour: policy.deployment_window_start_hour ?? null,
        deploymentWindowEndHour: policy.deployment_window_end_hour ?? null,
      })
    }
  }, [project])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    setVariables(JSON.stringify(environments?.[environment]?.variables || {}, null, 2))
  }, [environment, environments])

  async function act(action: () => Promise<Response>, successMessage: string) {
    setBusy(true); setMessage('')
    try {
      const response = await action()
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.message || 'Operation failed.')
      setMessage(successMessage)
      await load()
      return data
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operation failed.')
      return null
    } finally { setBusy(false) }
  }

  async function createInvitation() {
    const data = await act(() => fetch('/api/workspace/invitations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, targetAccountId: targetAccountId || undefined }),
    }), 'Invitation created. Copy its one-time token now.')
    if (data?.invitation?.token) setInvitationToken(data.invitation.token)
  }

  async function saveVariables() {
    let parsed: unknown
    try { parsed = JSON.parse(variables) } catch { setMessage('Variables must be valid JSON.'); return }
    await act(() => fetch(`/api/projects/${encodeURIComponent(project)}/environments/${environment}/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variables: parsed }),
    }), `${environment} configuration saved. Production approvals were invalidated when applicable.`)
  }

  async function rotateSecret() {
    const completed = await act(() => fetch(`/api/projects/${encodeURIComponent(project)}/environments/${environment}/secrets`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: secretName, value: secretValue }),
    }), `${environment} secret rotated without exposing its stored value.`)
    if (completed) { setSecretName(''); setSecretValue('') }
  }

  async function saveGovernance() {
    await act(() => fetch('/api/workspace/governance', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(governance),
    }), 'Production approval separation and deployment window saved.')
  }

  async function refreshHealth() {
    await act(() => fetch(`/api/projects/${encodeURIComponent(project)}/readiness/refresh-health`, { method: 'POST' }), 'Worker, Durable Object, and SQLite health refreshed.')
  }

  return <div className="workspace-settings-view">
    <p className="monitor-demo-notice" role="status"><ShieldCheck className="size-4" /> Workspace access, environment safety, recovery, and readiness controls. All writes are authorized and audited server-side.</p>
    {message && <div className="workspace-settings-message">{message}</div>}

    <section className="glass-card workspace-settings-card">
      <header><ListChecks className="size-5" /><div><h2>Guided onboarding</h2><p>Progress is saved after every step, so setup can be resumed safely.</p></div></header>
      <ul className="workspace-readiness-list">{onboardingSteps.map((step) => {
        const complete = onboarding.some((item) => item.step === step)
        return <li className={complete ? 'passed' : 'blocked'} key={step}>
          <span>{complete ? '✓' : '○'} {step.replace(/_/g, ' ')}</span>
          {!complete && <Button variant="outline" disabled={busy} onClick={() => void act(() => fetch(`/api/projects/${encodeURIComponent(project)}/onboarding/${step}`, { method: 'POST' }), `${step} onboarding step completed.`)}>Complete</Button>}
        </li>
      })}</ul>
    </section>

    <section className="workspace-settings-grid">
      <article className="glass-card workspace-settings-card">
        <header><Clock3 className="size-5" /><div><h2>Production governance</h2><p>Optional approver separation and a UTC deployment window. Emergency overrides remain audited.</p></div></header>
        <label className="workspace-policy-check"><input type="checkbox" checked={governance.requireSeparateVerifier} onChange={(event) => setGovernance((current) => ({ ...current, requireSeparateVerifier: event.target.checked }))} /> Release author cannot verify</label>
        <label className="workspace-policy-check"><input type="checkbox" checked={governance.requireSeparateApprover} onChange={(event) => setGovernance((current) => ({ ...current, requireSeparateApprover: event.target.checked }))} /> Change requester cannot approve</label>
        <label className="workspace-policy-check"><input type="checkbox" checked={governance.requireSeparateDeployer} onChange={(event) => setGovernance((current) => ({ ...current, requireSeparateDeployer: event.target.checked }))} /> Production approver cannot deploy</label>
        <div className="workspace-config-grid">
          <label>Start hour (UTC)<input type="number" min="0" max="23" value={governance.deploymentWindowStartHour ?? ''} onChange={(event) => setGovernance((current) => ({ ...current, deploymentWindowStartHour: event.target.value === '' ? null : Number(event.target.value) }))} /></label>
          <label>End hour (UTC)<input type="number" min="0" max="23" value={governance.deploymentWindowEndHour ?? ''} onChange={(event) => setGovernance((current) => ({ ...current, deploymentWindowEndHour: event.target.value === '' ? null : Number(event.target.value) }))} /></label>
        </div>
        <Button disabled={busy || (governance.deploymentWindowStartHour === null) !== (governance.deploymentWindowEndHour === null)} onClick={() => void saveGovernance()}>Save governance</Button>
      </article>

      <article className="glass-card workspace-settings-card">
        <header><Users className="size-5" /><div><h2>Members & roles</h2><p>Effective workspace permissions.</p></div></header>
        <div className="workspace-member-list">{members.map((member) => <div key={member.id}>
          <span><strong>{member.display_name}</strong><small>{member.accountIdHint}</small></span>
          <select value={member.role} disabled={busy} onChange={(event) => void act(() => fetch(`/api/workspace/members/${member.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: event.target.value }) }), 'Member role updated; their sessions were revoked.')}>
            {(['owner', 'admin', 'developer', 'operator', 'viewer'] as Role[]).map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>)}</div>
      </article>

      <article className="glass-card workspace-settings-card">
        <header><UserPlus className="size-5" /><div><h2>Invite member</h2><p>Tokens expire after seven days and are stored only as hashes.</p></div></header>
        <label>Role<select value={role} onChange={(event) => setRole(event.target.value as Exclude<Role, 'owner'>)}><option>admin</option><option>developer</option><option>operator</option><option>viewer</option></select></label>
        <label>Restrict to Cloudflare Account ID<input value={targetAccountId} onChange={(event) => setTargetAccountId(event.target.value)} placeholder="Optional 32-character account ID" /></label>
        <Button disabled={busy} onClick={() => void createInvitation()}>Create invitation</Button>
        {invitationToken && <code className="workspace-invitation-token">{invitationToken}</code>}
        <small>{invitations.filter((item) => !item.accepted_at && !item.revoked_at && item.expires_at > Date.now()).length} pending invitation(s)</small>
      </article>
    </section>

    <section className="glass-card workspace-settings-card">
      <header><KeyRound className="size-5" /><div><h2>Environment configuration</h2><p>Variables are visible; secret values are encrypted and never returned.</p></div></header>
      <div className="workspace-environment-tabs">{(['dev', 'staging', 'production'] as Environment[]).map((item) => <button className={environment === item ? 'active' : ''} onClick={() => setEnvironment(item)} key={item}>{item}</button>)}</div>
      <div className="workspace-config-grid">
        <label>Variables JSON<textarea rows={8} value={variables} onChange={(event) => setVariables(event.target.value)} /></label>
        <div><label>Secret name<input name="lacify-environment-secret-name" autoComplete="off" value={secretName} onChange={(event) => setSecretName(event.target.value.toUpperCase())} placeholder="PAYMENT_API_KEY" /></label><label>New value<input name="lacify-environment-secret-new-value" type="password" autoComplete="new-password" data-1p-ignore="true" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} /></label><Button disabled={busy || !secretName || !secretValue} onClick={() => void rotateSecret()}>Rotate secret</Button><p className="panel-desc">{environments?.[environment]?.secrets.map((secret) => secret.name).join(', ') || 'No secrets recorded.'}</p></div>
      </div>
      <Button disabled={busy} onClick={() => void saveVariables()}>Save {environment} configuration</Button>
      <p className="workspace-drift">{drift?.devToStaging ? 'Development differs from Staging.' : 'Development matches Staging.'} {drift?.stagingToProduction ? 'Staging differs from Production.' : 'Staging matches Production.'}</p>
    </section>

    <section className="workspace-settings-grid">
      <article className="glass-card workspace-settings-card">
        <header><ArchiveRestore className="size-5" /><div><h2>Recovery</h2><p>Cloudflare D1 Time Travel bookmarks and isolated restore validation.</p></div></header>
        <Button disabled={busy} onClick={() => void act(() => fetch('/api/backups', { method: 'POST' }), 'Verified recovery bookmark recorded.')}>Create recovery bookmark</Button>
        {backups[0] && <><small>Latest: {new Date(backups[0].created_at).toLocaleString()} · {backups[0].verification_status}</small><Button variant="outline" disabled={busy} onClick={() => void act(() => fetch(`/api/backups/${backups[0].id}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: `recovery_${project.replace(/_/g, '-')}` }) }), 'Isolated restore validation passed without overwriting Production.')}>Validate restore</Button></>}
      </article>

      <article className="glass-card workspace-settings-card">
        <header><CheckCircle2 className="size-5" /><div><h2>Production readiness</h2><p>{readiness?.ready ? 'All automated checks passed.' : 'Resolve the remaining readiness checks.'}</p></div></header>
        <ul className="workspace-readiness-list">{readiness?.checks.map((check) => <li className={check.passed ? 'passed' : 'blocked'} key={check.id}>{check.passed ? '✓' : '○'} {check.label}</li>)}</ul>
        <div className="workspace-settings-actions"><Button variant="outline" disabled={busy} onClick={() => void refreshHealth()}><RefreshCw className="size-3.5" /> Refresh health</Button><Button disabled={busy || !readiness?.ready} onClick={() => void act(() => fetch(`/api/projects/${encodeURIComponent(project)}/readiness-review`, { method: 'POST' }), 'Production-readiness review recorded.')}>Run review</Button></div>
      </article>
    </section>

    <section className="glass-card workspace-settings-card">
      <header><Wrench className="size-5" /><div><h2>Support diagnostics</h2><p>Exports operational evidence without credentials, command payloads, secrets, or business records.</p></div></header>
      <a className="monitor-runtime-link" href={`/api/projects/${encodeURIComponent(project)}/support-diagnostics`} target="_blank" rel="noreferrer">Open redacted diagnostics</a>
    </section>
  </div>
}
