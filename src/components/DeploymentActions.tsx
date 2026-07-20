import { useState } from 'react'
import { Rocket, ArrowRight, Loader2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DeploymentActionsProps {
  onDeploy: () => Promise<void>
  onPromoteStaging: () => Promise<void>
  onPromoteProd: () => Promise<void>
  devVersion?: string
  stagingVersion?: string
  prodVersion?: string
}

type LoadingState = 'deploy' | 'staging' | 'prod' | null

export function DeploymentActions({
  onDeploy,
  onPromoteStaging,
  onPromoteProd,
  devVersion = 'v1.0.0',
  stagingVersion = 'v0.0.0',
  prodVersion = 'v0.0.0',
}: DeploymentActionsProps) {
  const [loading, setLoading] = useState<LoadingState>(null)
  const [deployedToDev, setDeployedToDev] = useState(false)
  const [promotedToStaging, setPromotedToStaging] = useState(false)

  async function handleDeploy() {
    setLoading('deploy')
    try {
      await onDeploy()
      setDeployedToDev(true)
    } finally {
      setLoading(null)
    }
  }

  async function handlePromoteStaging() {
    setLoading('staging')
    try {
      await onPromoteStaging()
      setPromotedToStaging(true)
    } finally {
      setLoading(null)
    }
  }

  async function handlePromoteProd() {
    setLoading('prod')
    try {
      await onPromoteProd()
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="w-full">
      <div className="release-grid">
        {/* Step 1: Dev Environment */}
        <div className="release-stage release-stage--dev">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 px-1">
                <span className="relative flex size-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full size-2.5 bg-emerald-500" />
                </span>
                <span className="text-xs font-bold text-emerald-400 tracking-wide">
                  Development
                </span>
              </div>

              {/* Version Label with explicit inner padding & margin */}
              <span className="inline-flex items-center px-2.5 py-0.5 text-[11px] font-mono rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 ml-2">
                {devVersion}
              </span>
            </div>

            {/* Description label with padding/margin */}
            <p className="text-xs text-muted-foreground leading-normal px-1 my-2">
              Deploy the latest business-object contract and schema changes to the dev partition.
            </p>
          </div>

          <Button
            size="default"
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs h-9 px-4 gap-2 shadow-sm"
            onClick={handleDeploy}
            disabled={loading !== null}
          >
            {loading === 'deploy' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Rocket className="size-3.5" />
            )}
            <span className="px-1">Deploy to Dev</span>
          </Button>
        </div>

        {/* Step 2: Staging Environment */}
        <div
          className={`release-stage ${
            deployedToDev
              ? 'bg-amber-950/20 border-amber-500/30 shadow-sm hover:border-amber-500/50'
              : 'bg-white/[0.02] border-white/10 opacity-60'
          }`}
        >
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 px-1">
                <span
                  className={`size-2.5 rounded-full shrink-0 ${
                    deployedToDev ? 'bg-amber-400' : 'bg-white/20'
                  }`}
                />
                <span
                  className={`text-xs font-bold tracking-wide ${
                    deployedToDev ? 'text-amber-400' : 'text-muted-foreground'
                  }`}
                >
                  Staging
                </span>
              </div>

              <span className="inline-flex items-center px-2.5 py-0.5 text-[11px] font-mono rounded-md bg-white/5 text-muted-foreground border border-white/10 ml-2">
                {stagingVersion}
              </span>
            </div>

            <p className="text-xs text-muted-foreground leading-normal px-1 my-2">
              Promote verified build to preview integration cluster and run validation tests.
            </p>
          </div>

          <Button
            size="default"
            variant="outline"
            className={`w-full text-xs font-semibold h-9 px-4 gap-2 border-white/15 ${
              deployedToDev ? 'hover:bg-amber-500/10 hover:border-amber-500/40 text-amber-300' : ''
            }`}
            onClick={handlePromoteStaging}
            disabled={!deployedToDev || loading !== null}
          >
            {loading === 'staging' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ArrowRight className="size-3.5" />
            )}
            <span className="px-1">Promote to Staging</span>
          </Button>
        </div>

        {/* Step 3: Production Environment */}
        <div
          className={`release-stage ${
            promotedToStaging
              ? 'bg-sky-950/20 border-sky-500/30 shadow-sm hover:border-sky-500/50'
              : 'bg-white/[0.02] border-white/10 opacity-60'
          }`}
        >
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 px-1">
                <span
                  className={`size-2.5 rounded-full shrink-0 ${
                    promotedToStaging ? 'bg-sky-400' : 'bg-white/20'
                  }`}
                />
                <span
                  className={`text-xs font-bold tracking-wide ${
                    promotedToStaging ? 'text-sky-400' : 'text-muted-foreground'
                  }`}
                >
                  Production
                </span>
              </div>

              <span className="inline-flex items-center px-2.5 py-0.5 text-[11px] font-mono rounded-md bg-white/5 text-muted-foreground border border-white/10 ml-2">
                {prodVersion}
              </span>
            </div>

            <p className="text-xs text-muted-foreground leading-normal px-1 my-2">
              Publish edge partition build to live global network for production users.
            </p>
          </div>

          <Button
            size="default"
            variant="outline"
            className={`w-full text-xs font-semibold h-9 px-4 gap-2 border-white/15 ${
              promotedToStaging ? 'hover:bg-sky-500/10 hover:border-sky-500/40 text-sky-300' : ''
            }`}
            onClick={handlePromoteProd}
            disabled={!promotedToStaging || loading !== null}
          >
            {loading === 'prod' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="size-3.5" />
            )}
            <span className="px-1">Promote to Production</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
