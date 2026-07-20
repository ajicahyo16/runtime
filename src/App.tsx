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
import type { Actor } from '@/components/ActorCard'
import { saveContract } from '@/lib/contracts'

type Mode = 'builder' | 'monitor' | 'deploy' | 'universe' | 'simulate'
type Theme = 'dark' | 'light'

export default function App() {
  const [activeMode, setActiveMode] = useState<Mode>('builder')
  const [activeProject, setActiveProject] = useState('new-runtime')
  const [projects, setProjects] = useState<string[]>(['new-runtime'])
  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem('lacify-theme')
    return savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark'
  })
  const [isConnected, setIsConnected] = useState(false)
  const [uplinkAccount, setUplinkAccount] = useState('')
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
    fetch('/api/uplink-session')
      .then((response) => response.ok ? response.json() : null)
      .then((session) => {
        if (!session?.connected) return
        setIsConnected(true)
        setUplinkAccount(session.accountName || '')
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    fetch('/api/load-projects')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.projects) return
        setProjects(data.projects)
        const saved = localStorage.getItem('lacify-active-project')
        if (saved && data.projects.includes(saved)) setActiveProject(saved)
      })
      .catch(() => undefined)
  }, [])

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
    const deployBtn = document.getElementById('deployBtn') as HTMLButtonElement | null
    if (deployBtn) {
      deployBtn.click()
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  async function handlePromoteStaging() {
    const btn = document.getElementById('promoteStagingBtn') as HTMLButtonElement | null
    if (btn) {
      btn.click()
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  async function handlePromoteProd() {
    const btn = document.getElementById('promoteProdBtn') as HTMLButtonElement | null
    if (btn) {
      btn.click()
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
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
    const response = await fetch('/api/create-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, template }),
    })
    const data = await response.json()
    if (!response.ok || !data.success) throw new Error(data.message || 'Unable to create project.')
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

  return (
    <div className="app-layout">
      {/* Background glows */}
      <div className="bg-glow glow-1" />
      <div className="bg-glow glow-2" />

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
              {{ builder: 'Build', monitor: 'Monitor', deploy: 'Deploy', universe: 'Graph', simulate: 'Simulate' }[activeMode]}
            </span>
          </div>
          <div className="header-actions">
            <div className="header-status">
              <span className="status-indicator" />
              <span>Workspace ready</span>
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
          {activeMode === 'builder' && (
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

          {activeMode === 'monitor' && <MonitorView project={activeProject} />}

          {activeMode === 'deploy' && <DeployView project={activeProject} onDeploy={handleDeploy} onPromoteStaging={handlePromoteStaging} onPromoteProd={handlePromoteProd} />}

          {activeMode === 'universe' && <UniverseView project={activeProject} />}

          {activeMode === 'simulate' && <SimulateView project={activeProject} />}
        </main>
      </div>

      <UplinkModal
        isOpen={isUplinkOpen}
        onClose={() => setIsUplinkOpen(false)}
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
