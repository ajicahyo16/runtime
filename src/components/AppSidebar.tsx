import { Server, BarChart3, Circle, Play, Cloud, Plus, Rocket, Globe2, KeyRound, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

type Mode = 'builder' | 'webapp' | 'monitor' | 'deploy' | 'universe' | 'simulate' | 'access' | 'settings'

interface AppSidebarProps {
  activeMode: Mode
  onModeChange: (mode: Mode) => void
  isConnected: boolean
  onUplinkClick: () => void
  projects: string[]
  activeProject: string
  onProjectChange: (project: string) => void
  onCreateProject: () => void
  accountName?: string
}

const navGroups: Array<{ label: string; items: Array<{ mode: Mode; label: string; icon: React.ReactNode }> }> = [
  { label: 'Design', items: [{ mode: 'builder', label: 'Architecture', icon: <Server className="size-4" /> }, { mode: 'webapp', label: 'Web app', icon: <Globe2 className="size-4" /> }, { mode: 'simulate', label: 'Test lifecycle', icon: <Play className="size-4" /> }] },
  { label: 'Operate', items: [{ mode: 'monitor', label: 'Observability', icon: <BarChart3 className="size-4" /> }, { mode: 'deploy', label: 'Releases', icon: <Rocket className="size-4" /> }, { mode: 'access', label: 'Runtime access', icon: <KeyRound className="size-4" /> }, { mode: 'universe', label: 'Topology', icon: <Circle className="size-4" /> }, { mode: 'settings', label: 'Workspace', icon: <Settings className="size-4" /> }] },
]

export function AppSidebar({ activeMode, onModeChange, isConnected, onUplinkClick, projects, activeProject, onProjectChange, onCreateProject, accountName }: AppSidebarProps) {
  return (
    <aside className="app-sidebar">
      <div className="sidebar-logo">
        <div className="logo-orb" />
        <span className="logo-text">
          Lacify
        </span>
      </div>

      <div className="sidebar-context">
        <div className="context-workspace">
          <span className="context-label">Workspace</span>
          <span className="context-value">darlin-workspace</span>
        </div>
        <div className="context-project">
          <span className="context-label">Project</span>
          <select className="project-select" value={activeProject} onChange={(event) => onProjectChange(event.target.value)}>
            {projects.map((project) => <option key={project} value={project}>{project}</option>)}
          </select>
          <button className="sidebar-new-project" onClick={onCreateProject}><Plus className="size-3" /> New project</button>
        </div>
      </div>

      <nav className="sidebar-nav">
        {navGroups.map((group) => <div className="sidebar-nav__group" key={group.label}>
          <div className="sidebar-label">{group.label}</div>
          {group.items.map(({ mode, label, icon }) => <button key={mode} className={cn('nav-link mode-btn', activeMode === mode && 'active')} onClick={() => onModeChange(mode)}>{icon}<span>{label}</span></button>)}
        </div>)}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-uplink">
        <button
          className="uplink-btn"
          data-connected={isConnected}
          onClick={onUplinkClick}
        >
          <span className="uplink-dot" />
          <Cloud className="size-4" />
          <span>{isConnected ? `Connected${accountName ? ` · ${accountName}` : ''}` : 'Connect Uplink'}</span>
        </button>
      </div>
    </aside>
  )
}
