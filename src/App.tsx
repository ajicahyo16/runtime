import { useState, useEffect } from 'react'
import { Moon, Sun } from 'lucide-react'
import { AppSidebar } from '@/components/AppSidebar'
import { ActorsGrid } from '@/components/ActorsGrid'
import { UplinkModal } from '@/components/UplinkModal'
import { AIBuilderModal } from '@/components/AIBuilderModal'
import { AIProposalModal } from '@/components/AIProposalModal'
import { BusinessObjectDesigner } from '@/components/BusinessObjectDesigner'
import { MonitorView } from '@/components/MonitorView'
import { UniverseView } from '@/components/UniverseView'
import { SimulateView } from '@/components/SimulateView'
import { NewProjectModal } from '@/components/NewProjectModal'
import { NewBusinessObjectModal } from '@/components/NewBusinessObjectModal'
import { DeployView } from '@/components/DeployView'
import { WebAppBlueprintView } from '@/components/WebAppBlueprintView'
import { WorkspaceSettingsView } from '@/components/WorkspaceSettingsView'
import { RuntimeAccessView } from '@/components/RuntimeAccessView'
import { DeviceApprovalView } from '@/components/DeviceApprovalView'
import type { Actor } from '@/components/ActorCard'
import { loadProjects, saveContract, type ProjectSummary } from '@/lib/contracts'
import { validateContract } from '@/lib/contract-validation'

type Mode = 'builder' | 'webapp' | 'monitor' | 'deploy' | 'universe' | 'simulate' | 'access' | 'settings'
type Theme = 'dark' | 'light'
interface ApplicationUser { id: string; displayName: string; provider: string }

export default function App() {
  const [activeMode, setActiveMode] = useState<Mode>('builder')
  const [activeProject, setActiveProject] = useState('new-runtime')
  const [projects, setProjects] = useState<string[]>(['new-runtime'])
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([])
  const [projectsReady, setProjectsReady] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem('lacify-theme')
    return savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark'
  })
  const [isConnected, setIsConnected] = useState(false)
  const [uplinkAccount, setUplinkAccount] = useState('')
  const [applicationUser, setApplicationUser] = useState<ApplicationUser | null>(null)
  const [authenticationReady, setAuthenticationReady] = useState(false)
  const [isUplinkOpen, setIsUplinkOpen] = useState(false)
  const [isAIBuilderOpen, setIsAIBuilderOpen] = useState(false)
  const [isProposalOpen, setIsProposalOpen] = useState(false)
  const [proposal, setProposal] = useState<any>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [selectedActorForDesigner, setSelectedActorForDesigner] = useState<Actor | null>(null)
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false)
  const [isNewBusinessObjectOpen, setIsNewBusinessObjectOpen] = useState(false)
  const [createAfterUplink, setCreateAfterUplink] = useState(false)

  useEffect(() => {
    const handleOpenDesignerEvent = (e: any) => {
      if (e.detail) {
        setSelectedActorForDesigner(e.detail)
      }
    }
    window.addEventListener('openDesigner', handleOpenDesignerEvent)
    return () => window.removeEventListener('openDesigner', handleOpenDesignerEvent)
  }, [])

  useEffect(() => {
    fetch('/api/auth/session')
      .then((response) => response.ok ? response.json() : null)
      .then(async (session) => {
        if (!session?.authenticated) return
        setApplicationUser(session.user)
        if (session.refreshRecommended) await fetch('/api/auth/session/refresh', { method: 'POST' }).catch(() => undefined)
      })
      .catch(() => undefined)
      .finally(() => setAuthenticationReady(true))
  }, [])

  useEffect(() => {
    if (!authenticationReady || !applicationUser) {
      if (authenticationReady) {
        setIsConnected(false)
        setUplinkAccount('')
      }
      return
    }
    fetch('/api/uplink-session')
      .then((response) => response.ok ? response.json() : null)
      .then((session) => {
        setIsConnected(Boolean(session?.connected))
        setUplinkAccount(session?.accountName || '')
      })
      .catch(() => undefined)
  }, [authenticationReady, applicationUser])

  useEffect(() => {
    if (!authenticationReady) return
    loadProjects()
      .then((data) => {
        const projectIds = data.projects.map((project) => project.id)
        setProjects(projectIds)
        setProjectSummaries(data.projects)
        const saved = localStorage.getItem('lacify-active-project')
        if (saved && projectIds.includes(saved)) setActiveProject(saved)
        else if (projectIds.length) setActiveProject(projectIds[0])
        setProjectsReady(true)
      })
      .catch(() => setProjectsReady(true))
  }, [authenticationReady, applicationUser])

  useEffect(() => {
    localStorage.setItem('lacify-active-project', activeProject)
    setSelectedActorForDesigner(null)
    setReloadKey((key) => key + 1)
  }, [activeProject])

  useEffect(() => {
    if (isConnected && createAfterUplink) {
      setCreateAfterUplink(false)
      setIsNewProjectOpen(true)
    }
  }, [isConnected, createAfterUplink])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('lacify-theme', theme)
  }, [theme])

  async function handleDeploy() {
    setSelectedActorForDesigner(null)
    setActiveMode('deploy')
  }

  function handleActorClick(actor: Actor) {
    setSelectedActorForDesigner(actor)
  }

  async function handleCreateBusinessObject(name: string) {
    const id = name.toLowerCase().replace(/\s+/g, '-')
    const typeName = name.split(' ')[0]

    const newActor: Actor = {
      id,
      name,
      aggregateType: typeName,
      key: `${typeName.toLowerCase()}Id`,
      size: '1.0 MB',
      queries: 0,
      status: 'dormant',
      objects: [{ name: typeName, fields: 'id, createdAt' }],
      actions: [`Create${typeName}`, `Update${typeName}`],
      states: [{ obj: typeName, flow: ['Draft', 'Active', 'Completed'] }]
    }

    await handleSaveActor(newActor)
  }

  const handleSaveActor = async (actorToSave: Actor) => {
    try {
      const validation = validateContract(actorToSave)
      if (!validation.valid) throw new Error(validation.issues[0].message)
      // A project selected before Uplink may be a browser-local draft. Claim it
      // in the Control API before saving its first aggregate, so authoring and
      // immutable releases always refer to the same project record.
      if (isConnected) {
        const projectResponse = await fetch('/api/projects', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: activeProject, name: activeProject }),
        })
        if (!projectResponse.ok && projectResponse.status !== 409) {
          const data = await projectResponse.json().catch(() => null)
          throw new Error(data?.message || 'The active project could not be prepared in the Control API.')
        }
      }
      await saveContract(activeProject, actorToSave)

      if ((window as any).STATE && (window as any).STATE.activeActors) {
        const idx = (window as any).STATE.activeActors.findIndex((a: any) => a.id === actorToSave.id)
        if (idx >= 0) {
          ;(window as any).STATE.activeActors[idx] = actorToSave
        } else {
          ;(window as any).STATE.activeActors.push(actorToSave)
        }
      }

      setReloadKey((prev) => prev + 1)
    } catch (e: any) {
      alert(`Failed to save: ${e.message}`)
      throw e
    }
  }

  function handleAIBuilder() {
    setIsAIBuilderOpen(true)
  }

  function requestNewProject() {
    if (isConnected) {
      setIsNewProjectOpen(true)
    } else {
      setCreateAfterUplink(true)
      setIsUplinkOpen(true)
    }
  }

  async function createProject(name: string, template: 'blank' | 'commerce' | 'inventory' | 'clinic' | 'billing') {
    let created = false
    try {
      const response = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: name, name }),
      })
      const data = await response.json().catch(() => null)
      if (response.ok && data?.success) created = true
      else if (response.status !== 404 && response.status !== 405 && response.headers.get('content-type')?.includes('application/json')) throw new Error(data?.message || 'Unable to create project.')
    } catch (error) {
      if (error instanceof Error && !/Failed to fetch|NetworkError/i.test(error.message)) throw error
    }
    if (!created) {
      const response = await fetch('/api/create-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, template }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.message || 'Unable to create project.')
    }
    setProjects((current) => [...current, name].sort())
    setActiveProject(name)
    setActiveMode('builder')
  }

  async function handleAcceptProposal() {
    if (!proposal) return

    const isClinic = proposal.name.toLowerCase().includes('clinic')
    const isBilling = proposal.name.toLowerCase().includes('billing')
    const typeName = proposal.name.split(' ')[0]

    const newActor: Actor = {
      id: proposal.id,
      name: proposal.name,
      aggregateType: typeName,
      key: isClinic ? 'appointmentId' : (isBilling ? 'invoiceId' : 'itemId'),
      size: '1.2 MB',
      queries: 0,
      status: 'dormant',
      objects: proposal.objects,
      actions: proposal.actions,
      states: proposal.states
    }

    await handleSaveActor(newActor)
    setIsProposalOpen(false)
    setProposal(null)
    setSelectedActorForDesigner(newActor)
  }

  if (window.location.pathname === '/device') {
    return <DeviceApprovalView authenticated={Boolean(applicationUser)} authenticationReady={authenticationReady} />
  }

  return (
    <div className="app-layout">
      <AppSidebar
        activeMode={activeMode}
        onModeChange={(mode) => {
          setActiveMode(mode)
          setSelectedActorForDesigner(null)
        }}
        isConnected={isConnected}
        onUplinkClick={() => setIsUplinkOpen(true)}
        projects={projects}
        activeProject={activeProject}
        onProjectChange={setActiveProject}
        onCreateProject={requestNewProject}
        accountName={uplinkAccount}
      />

      <div className="main-content-layout">
        {/* Top bar */}
        <header className="clean-header">
          <div className="breadcrumbs">
            <span className="crumb">darlin-workspace</span>
            <span className="crumb-separator">/</span>
            <span className="crumb">{activeProject}</span>
            <span className="crumb-separator">/</span>
            <span className="crumb active">
              {{ builder: 'Architecture', webapp: 'Web app', monitor: 'Observability', deploy: 'Releases', universe: 'Topology', simulate: 'Test lifecycle', access: 'Runtime access', settings: 'Workspace' }[activeMode]}
            </span>
          </div>
          <label className="mobile-mode-picker">
            <span>View</span>
            <select value={activeMode} onChange={(event) => {
              setActiveMode(event.target.value as Mode)
              setSelectedActorForDesigner(null)
            }}>
              <option value="builder">Architecture</option>
              <option value="webapp">Web app</option>
              <option value="simulate">Test lifecycle</option>
              <option value="monitor">Observability</option>
              <option value="deploy">Releases</option>
              <option value="access">Runtime access</option>
              <option value="universe">Topology</option>
              <option value="settings">Workspace</option>
            </select>
          </label>
          <div className="header-actions">
            <div className="header-status">
              <span className="status-indicator" />
              <span>{projectSummaries.find((project) => project.id === activeProject)?.authoring_source === 'repository' ? 'File-managed project' : 'Visual project'} · Workspace ready</span>
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </header>

        <main className="main-container">
          {!projectsReady ? <div className="build-empty">Loading workspace…</div> : activeMode === 'builder' && (
            <>
              {selectedActorForDesigner ? (
                <BusinessObjectDesigner
                  actor={selectedActorForDesigner}
                  onClose={() => setSelectedActorForDesigner(null)}
                  onDeploy={handleDeploy}
                  onSaveActor={handleSaveActor}
                />
              ) : (
                <>
                  <ActorsGrid
                    onActorClick={handleActorClick}
                    onAddBusinessObject={() => setIsNewBusinessObjectOpen(true)}
                    onAIBuilder={handleAIBuilder}
                    project={activeProject}
                    reloadKey={reloadKey}
                  />
                </>
              )}
            </>
          )}

          {activeMode === 'monitor' && <MonitorView project={activeProject} onOpenReleases={() => setActiveMode('deploy')} />}

          {activeMode === 'webapp' && <WebAppBlueprintView project={activeProject} />}

          {activeMode === 'deploy' && <DeployView project={activeProject} />}

          {activeMode === 'universe' && <UniverseView project={activeProject} />}

          {activeMode === 'simulate' && <SimulateView project={activeProject} />}

          {activeMode === 'access' && <RuntimeAccessView project={activeProject} onOpenReleases={() => setActiveMode('deploy')} />}

          {activeMode === 'settings' && <WorkspaceSettingsView project={activeProject} />}
        </main>
      </div>

      <UplinkModal
        isOpen={isUplinkOpen}
        onClose={() => setIsUplinkOpen(false)}
        authenticatedUser={applicationUser}
        onAuthenticationChange={setApplicationUser}
        onConnectionSuccess={(connected, accountName) => {
          setIsConnected(connected)
          setUplinkAccount(accountName || '')
        }}
        currentEnv="dev"
      />

      <AIBuilderModal
        isOpen={isAIBuilderOpen}
        onClose={() => setIsAIBuilderOpen(false)}
        onGenerateProposal={(prop) => {
          setIsAIBuilderOpen(false)
          setProposal(prop)
          setIsProposalOpen(true)
        }}
      />

      <AIProposalModal
        isOpen={isProposalOpen}
        proposal={proposal}
        onReject={() => setIsProposalOpen(false)}
        onAccept={handleAcceptProposal}
      />

      <NewProjectModal isOpen={isNewProjectOpen} onClose={() => setIsNewProjectOpen(false)} onCreate={createProject} />
      <NewBusinessObjectModal
        isOpen={isNewBusinessObjectOpen}
        onClose={() => setIsNewBusinessObjectOpen(false)}
        onCreate={handleCreateBusinessObject}
      />
    </div>
  )
}
