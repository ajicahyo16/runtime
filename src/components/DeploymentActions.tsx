import { ArrowRight, CheckCircle2, LockKeyhole, Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'

const stages = [
  { name: 'Development', detail: 'Compile an immutable release, provision isolated resources, then run smoke checks.', state: 'Available after a release is compiled' },
  { name: 'Staging', detail: 'Promote the exact development-verified release and run integration and migration checks.', state: 'Requires verified development release' },
  { name: 'Production', detail: 'Require an approved staging release, a reviewed change plan, and rollback readiness.', state: 'Requires staging verification and approval' },
]

export function DeploymentActions({ isConnected, releaseReady, developmentPlanned, onDeployDevelopment, busy }: { isConnected: boolean; releaseReady: boolean; developmentPlanned: boolean; onDeployDevelopment?: () => void; busy?: boolean }) {
  return <div className="release-grid">{stages.map((stage, index) => {
    const development = index === 0
    const state = development
      ? !isConnected ? 'Connect the Control API to continue'
        : developmentPlanned ? 'Development job is ready to run'
        : releaseReady ? 'Ready to provision isolated development resources'
          : 'Verify a compiled release to unlock deployment planning'
      : index === 1 ? 'Unlocks after development smoke checks' : stage.state
    return <section key={stage.name} className={`release-stage release-stage--${development ? 'dev' : 'locked'} ${development && releaseReady ? 'is-ready' : ''}`}><div><div className="release-stage__heading">{development ? <Rocket className="size-4" /> : index === 2 ? <CheckCircle2 className="size-4" /> : <LockKeyhole className="size-4" />}<h3>{stage.name}</h3></div><p>{stage.detail}</p></div><div><span className="release-stage__state">{state}</span>{development && <Button size="sm" className="release-stage__cta" disabled={!releaseReady || busy} onClick={onDeployDevelopment}>{busy ? 'Preparing…' : developmentPlanned ? 'Run development deployment' : <><span>Deploy development</span><ArrowRight className="size-3.5" /></>}</Button>}</div></section>
  })}</div>
}
