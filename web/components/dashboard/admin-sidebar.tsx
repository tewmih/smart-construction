'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Users,
  Settings,
  Megaphone,
  FileSearch,
  BarChart3,
  LogOut,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useAuth } from '@/lib/auth-context'
import { SiteLogo } from '@/components/site-logo'

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, exact: true },
  { label: 'Users', href: '/dashboard/admin/users', icon: Users },
  { label: 'Audit Logs', href: '/dashboard/admin/audit-logs', icon: FileSearch },
  { label: 'Settings', href: '/dashboard/admin/settings', icon: Settings },
  { label: 'Announcements', href: '/dashboard/admin/announcements', icon: Megaphone },
  { label: 'Reports', href: '/dashboard/admin/reports', icon: BarChart3 },
]

export function AdminSidebar() {
  const pathname = usePathname()
  const { user, logout } = useAuth()
  const [collapsed, setCollapsed] = useState(false)

  const initials = user?.full_name
    .split(' ')
    .filter((n) => n.length > 0)
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'A'

  return (
    <aside
      className={cn(
        'flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border/60 transition-all duration-300',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <div
        className={cn(
          'h-16 flex items-center border-b border-sidebar-border/60',
          collapsed ? 'justify-center px-2' : 'justify-between px-4',
        )}
      >
        {!collapsed && (
          <Link href="/dashboard" className="flex items-center gap-2 min-w-0">
            <SiteLogo imageClassName="h-10 w-10" textClassName="text-lg" />
          </Link>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="text-sidebar-foreground hover:bg-sidebar-accent h-8 w-8 shrink-0"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>

      {!collapsed && (
        <div className="p-4 border-b border-sidebar-border/60">
          <p className="text-xs text-sidebar-foreground/60 uppercase tracking-wider mb-1">
            Admin Console
          </p>
          <h2 className="font-semibold text-sm truncate">System Management</h2>
        </div>
      )}

      <ScrollArea className="flex-1 py-4">
        <nav className="space-y-1 px-2">
          {NAV_ITEMS.map((item) => {
            const isActive = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'group relative flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-card/14 text-sidebar-primary shadow-sm'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
                title={collapsed ? item.label : undefined}
              >
                {isActive && !collapsed && (
                  <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-primary" />
                )}
                <item.icon className={cn('h-5 w-5 shrink-0', collapsed && 'mx-auto')} />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            )
          })}
        </nav>
      </ScrollArea>

      <div className="mt-auto border-t border-sidebar-border/60">
        <Separator className="bg-sidebar-border/70" />
        <div className={cn('p-4 flex items-center gap-3', collapsed && 'justify-center p-2')}>
          <Link
            href="/dashboard/profile"
            className={cn('flex min-w-0 flex-1 items-center gap-3', collapsed && 'justify-center')}
          >
            <Avatar className="h-9 w-9">
              <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-xs">
                {initials}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{user?.full_name}</p>
                <p className="text-xs text-sidebar-foreground/60 truncate">{user?.email}</p>
              </div>
            )}
          </Link>
          {!collapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent h-8 w-8"
              onClick={() => void logout()}
              aria-label="Logout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </aside>
  )
}
