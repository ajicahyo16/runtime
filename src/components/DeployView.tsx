import { CloudCog, Info } from 'lucide-react'
import { DeploymentActions } from '@/components/DeploymentActions'

interface DeployViewProps {
  project: string
  onDeploy: () => Promise<void>
  onPromoteStaging: () => Promise<void>
  onPromoteProd: () => Promise<void>
}

export function DeployView({ project, onDeploy, onPromoteStaging, onPromoteProd }: DeployViewProps) {
  return (
    <section className="glass-card workspace-panel deploy-view">
      <div className="workspace-panel__header">
        <div className="workspace-panel__title">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="section-icon"><CloudCog className="size-4" /></span>
            <h2 className="text-xl font-bold tracking-tight">Deploy</h2>
          </div>
          <p className="text-xs text-muted-foreground">Promote a verified release of <span className="font-mono text-foreground">{project}</span> through isolated environments.</p>
        </div>
      </div>
      <p className="deploy-view__notice" role="status"><Info className="size-4" /> Deployment preview — Cloudflare provisioning will be connected when the Control API is implemented. These controls only demonstrate the promotion flow.</p>
      <DeploymentActions onDeploy={onDeploy} onPromoteStaging={onPromoteStaging} onPromoteProd={onPromoteProd} />
    </section>
  )
}
