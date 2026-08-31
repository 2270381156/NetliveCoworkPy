import { NavLink } from 'react-router-dom'
import { clsx } from 'clsx'
import {
  LayoutDashboard,
  Cpu,
  FileText,
  Zap,
  Server,
} from 'lucide-react'

const navItems = [
  { to: '/sessions', icon: LayoutDashboard, label: 'Sessions' },
  { to: '/templates', icon: FileText, label: 'Templates' },
  { to: '/llms', icon: Cpu, label: 'LLM Providers' },
  { to: '/mcp', icon: Server, label: 'MCP Servers' },
]

export function Sidebar() {
  return (
    <nav className="w-56 bg-white border-r border-gray-200 flex flex-col h-full flex-shrink-0">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Zap size={20} className="text-blue-600" />
          <span className="font-semibold text-gray-900 text-sm">CtxWeft</span>
        </div>
      </div>

      {/* Nav */}
      <div className="flex-1 py-3 px-2">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors mb-0.5',
                isActive
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              )
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-100">
        <p className="text-xs text-gray-400">CtxWeft Agent Runtime</p>
      </div>
    </nav>
  )
}
