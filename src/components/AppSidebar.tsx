import { Server, BarChart3, Circle, Play, Cloud, Plus, Rocket } from 'lucide-react'
import { cn } from '@/lib/utils'

type Mode = 'builder' | 'monitor' | 'deploy' | 'universe' | 'simulate'

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

const navItems: { mode: Mode; label: string; icon: React.ReactNode }[] = [
  { mode: 'builder', label: 'Build', icon: <Server className="size-4" /> },
  { mode: 'monitor', label: 'Monitor', icon: <BarChart3 className="size-4" /> },
  { mode: 'deploy', label: 'Deploy', icon: <Rocket className="size-4" /> },
  { mode: 'universe', label: 'Graph', icon: <Circle className="size-4" /> },
  { mode: 'simulate', label: 'Simulate', icon: <Play className="size-4" /> },
]

export function AppSidebar({ activeMode, onModeChange, isConnected, onUplinkClick, projects, activeProject, onProjectChange, onCreateProject, accountName }: AppSidebarProps) {
  return (
    <aside className="app-sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="logo-orb" />
        <span className="logo-text">
          Lacify <span className="accent-text">Console</span>
        </span>
      </div>

      {/* Workspace context */}
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

      {/* Navigation */}
      <nav className="sidebar-nav">
        <div className="sidebar-label">Navigation</div>
        {navItems.map(({ mode, label, icon }) => (
          <button
            key={mode}
            className={cn('nav-link mode-btn', activeMode === mode && 'active')}
            onClick={() => onModeChange(mode)}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-spacer" />

      {/* Uplink */}
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
