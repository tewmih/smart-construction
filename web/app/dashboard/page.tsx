'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/lib/auth-context'
import { SiteLogo } from '@/components/site-logo'
import { ProjectSelectionModal } from '@/components/project-selection-modal'
import { AnnouncementBanner } from '@/components/announcement-banner'
import {
  ArrowRight,
  Building2,
  Calendar,
  ChevronDown,
  Loader2,
  LogOut,
  MapPin,
  Moon,
  Plus,
  Settings,
  Sun,
  TrendingUp,
  User,
  Users,
  Package,
  Truck,
  Activity,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { useTheme } from 'next-themes'
import { fetchMyProjects, getRecentActivity, getSystemHealth, getActivitySummary, type SystemHealth, type ActivitySeriesPoint } from '@/lib/api'
import type { ProjectListItem } from '@/lib/api-types'
import type { AdminStatsResponse, AuditLogItem } from '@/lib/api-types'
import { getAdminStats } from '@/lib/api'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { roleLabels, statusColors } from '@/lib/domain'
import { PieChart, Pie, Cell, Tooltip } from 'recharts'

// Project Status Chart Component
function Sparkline({ data, dataKey, color }: { data: ActivitySeriesPoint[]; dataKey: keyof ActivitySeriesPoint; color: string }) {
  if (!data || data.length < 2) return null
  return (
    <div className="h-8 mt-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line type="monotone" dataKey={dataKey as string} stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function Row({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className={ok ? 'font-medium text-emerald-700' : 'font-medium text-red-700'}>{v}</span>
    </div>
  )
}

function ProjectStatusChart({ stats }: { stats: AdminStatsResponse }) {
  const chartData = [
    {
      name: 'Planning',
      value: stats.projects_by_status?.planning ?? 0,
      fill: '#3b82f6', // blue
    },
    {
      name: 'In Progress',
      value: stats.projects_by_status?.in_progress ?? 0,
      fill: '#10b981', // green
    },
    {
      name: 'Completed',
      value: stats.projects_by_status?.completed ?? 0,
      fill: '#8b5cf6', // purple
    },
    {
      name: 'On Hold',
      value: stats.projects_by_status?.on_hold ?? 0,
      fill: '#f59e0b', // orange
    },
  ].filter((item) => item.value > 0)

  // Only show chart if there's data
  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No project data available
      </div>
    )
  }

  return (
    <div className="flex flex-col md:flex-row items-center gap-8">
      {/* Pie Chart */}
      <div className="w-full md:w-1/2 flex justify-center">
        <PieChart width={300} height={300}>
          <Pie
            data={chartData}
            cx={150}
            cy={150}
            labelLine={false}
            label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
            outerRadius={100}
            dataKey="value"
          >
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.fill} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </div>

      {/* Legend */}
      <div className="w-full md:w-1/2 space-y-4">
        {chartData.map((item) => (
          <div key={item.name} className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-4 h-4 rounded"
                style={{ backgroundColor: item.fill }}
              />
              <span className="text-sm font-medium">{item.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold">{item.value}</span>
              <span className="text-sm text-muted-foreground">
                ({((item.value / stats.total_projects) * 100).toFixed(1)}%)
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DashboardProjectListPage() {
  const router = useRouter()
  const { user, isAuthenticated, isLoading: authLoading, logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const [modalOpen, setModalOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [stats, setStats] = useState<AdminStatsResponse | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [recentActivity, setRecentActivity] = useState<AuditLogItem[]>([])
  const [health, setHealth] = useState<SystemHealth | null>(null)
  const [activitySeries, setActivitySeries] = useState<ActivitySeriesPoint[]>([])

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login')
    }
  }, [authLoading, isAuthenticated, router])

  useEffect(() => {
    if (!isAuthenticated || !user) return

    let cancelled = false

      ; (async () => {
        setProjectsLoading(true)
        setProjectsError(null)
        try {
          const visibleProjects = await fetchMyProjects(user.id)
          if (!cancelled) {
            setProjects(visibleProjects)
          }
        } catch (error) {
          if (!cancelled) {
            setProjects([])
            setProjectsError(error instanceof Error ? error.message : 'Failed to load your projects')
          }
        } finally {
          if (!cancelled) {
            setProjectsLoading(false)
          }
        }
      })()

    return () => {
      cancelled = true
    }
  }, [isAuthenticated, user?.id])

  // Load admin stats + recent activity + system health if user is admin
  useEffect(() => {
    if (!isAuthenticated || !user?.is_admin) return

    let cancelled = false

      ; (async () => {
        setStatsLoading(true)
        try {
          const [data, activity, hp, summary] = await Promise.all([
            getAdminStats(),
            getRecentActivity(6).catch(() => []),
            getSystemHealth().catch(() => null),
            getActivitySummary(30).catch(() => ({ days: 30, series: [] as ActivitySeriesPoint[] })),
          ])
          if (!cancelled) {
            setStats(data)
            setRecentActivity(Array.isArray(activity) ? activity : [])
            setHealth(hp)
            setActivitySeries(summary?.series ?? [])
          }
        } catch (error) {
          console.error('Failed to load admin stats:', error)
        } finally {
          if (!cancelled) {
            setStatsLoading(false)
          }
        }
      })()

    return () => {
      cancelled = true
    }
  }, [isAuthenticated, user?.is_admin])

  const handleLogout = async () => {
    await logout()
    router.push('/')
  }

  const handleModalChange = (open: boolean) => {
    setModalOpen(open)
  }

  const handleOpenProject = (projectId: string) => {
    router.push(`/dashboard/${projectId}`)
  }

  const initials = user?.full_name
    .split(' ')
    .filter(n => n.length > 0)
    .map(n => n[0])
    .join('')
    .toUpperCase() || 'U'

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!isAuthenticated) return null

  return (
    <div className="min-h-screen bg-background">
      {/* Announcement Banner - Very Top */}
      <AnnouncementBanner />

      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <SiteLogo imageClassName="h-12 w-12" textClassName="text-xl text-foreground" />
          </Link>
          <div className="flex items-center gap-4">
            {/* Profile Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 pl-2 pr-3">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="hidden sm:block text-left">
                    <p className="text-sm font-medium leading-none max-w-[120px] truncate">{user?.full_name}</p>
                    <p className="text-xs text-muted-foreground">{user?.email}</p>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div>
                    <p className="font-medium">{user?.full_name}</p>
                    <p className="text-xs text-muted-foreground font-normal">{user?.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => router.push('/dashboard/profile')}>
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push('/dashboard/settings')}>
                  <Settings className="mr-2 h-4 w-4" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                  {theme === 'dark' ? (
                    <>
                      <Sun className="mr-2 h-4 w-4" />
                      Light Mode
                    </>
                  ) : (
                    <>
                      <Moon className="mr-2 h-4 w-4" />
                      Dark Mode
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setModalOpen(true)}>
                  <Building2 className="mr-2 h-4 w-4" />
                  Select Project
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-destructive">
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Admin Dashboard */}
        {user?.is_admin ? (
          <div className="space-y-8">
            <div className="space-y-2">
              <p className="text-sm font-medium uppercase tracking-[0.25em] text-muted-foreground">
                Admin Dashboard
              </p>
              <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                System Management
              </h1>
              <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
                Platform statistics and management tools
              </p>
            </div>

            {/* Platform Stats */}
            {statsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : stats ? (
              <>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  {/* Total Users */}
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">Total Users</CardTitle>
                      <Users className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{stats.total_users}</div>
                      <p className="text-xs text-muted-foreground">{stats.active_users} active · last 30d signups below</p>
                      <Sparkline data={activitySeries} dataKey="signups" color="#10b981" />
                    </CardContent>
                  </Card>

                  {/* Total Projects */}
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">Total Projects</CardTitle>
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{stats.total_projects}</div>
                      <p className="text-xs text-muted-foreground">
                        {stats.projects_by_status?.in_progress ?? 0} in progress · audit events below
                      </p>
                      <Sparkline data={activitySeries} dataKey="audit_events" color="#f59e0b" />
                    </CardContent>
                  </Card>



                  {/* Suppliers */}
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">Suppliers</CardTitle>
                      <Package className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{stats.total_suppliers}</div>
                      <p className="text-xs text-muted-foreground">Registered · log approvals below</p>
                      <Sparkline data={activitySeries} dataKey="log_approvals" color="#a855f7" />
                    </CardContent>
                  </Card>
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  {/* Projects by Status Chart */}
                  {stats.total_projects > 0 && (
                    <Card className="lg:col-span-2">
                      <CardHeader>
                        <CardTitle>Projects by Status</CardTitle>
                        <CardDescription>Distribution of projects across different statuses</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <ProjectStatusChart stats={stats} />
                      </CardContent>
                    </Card>
                  )}

                  {/* System Health Card */}
                  {health && (
                    <Card>
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <CardTitle>System Health</CardTitle>
                          <Badge
                            variant="outline"
                            className={health.status === 'ok'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-amber-50 text-amber-700 border-amber-200'}
                          >
                            {health.status === 'ok' ? 'Healthy' : 'Degraded'}
                          </Badge>
                        </div>
                        <CardDescription>Live indicators across the platform</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm">
                        <Row k="Database" v={health.database.reachable ? 'Reachable' : 'Unreachable'} ok={health.database.reachable} />
                        <Row k="ML model" v={health.ml_model_loaded ? 'Loaded' : 'Not loaded'} ok={health.ml_model_loaded} />
                        <Row k="Audit events / hr" v={`${health.audit_events_last_hour}`} ok={health.audit_events_last_hour >= 0} />
                        <div className="pt-2 mt-2 border-t border-border">
                          <p className="text-xs uppercase text-muted-foreground mb-1">Row counts</p>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                            {Object.entries(health.row_counts).map(([k, v]) => (
                              <div key={k} className="flex justify-between">
                                <span className="text-muted-foreground">{k}</span>
                                <span className="font-medium">{v.toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>

              </>
            ) : null}

            {/* Admin Management Cards */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {/* User Management */}
              <Card className="group cursor-pointer transition-shadow hover:shadow-lg" onClick={() => router.push('/dashboard/admin/users')}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <Users className="h-8 w-8 text-primary" />
                    <ArrowRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <CardTitle className="mt-4">User Management</CardTitle>
                  <CardDescription>Manage system users, roles, and permissions</CardDescription>
                </CardHeader>
              </Card>

              {/* Audit Logs */}
              <Card className="group cursor-pointer transition-shadow hover:shadow-lg" onClick={() => router.push('/dashboard/admin/audit-logs')}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <svg className="h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <ArrowRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <CardTitle className="mt-4">Audit Logs</CardTitle>
                  <CardDescription>View system activity and user actions</CardDescription>
                </CardHeader>
              </Card>

              {/* System Settings */}
              <Card className="group cursor-pointer transition-shadow hover:shadow-lg" onClick={() => router.push('/dashboard/admin/settings')}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <Settings className="h-8 w-8 text-primary" />
                    <ArrowRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <CardTitle className="mt-4">System Settings</CardTitle>
                  <CardDescription>Configure system-wide settings and preferences</CardDescription>
                </CardHeader>
              </Card>

              {/* Announcements */}
              <Card className="group cursor-pointer transition-shadow hover:shadow-lg" onClick={() => router.push('/dashboard/admin/announcements')}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <svg className="h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                    </svg>
                    <ArrowRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <CardTitle className="mt-4">Announcements</CardTitle>
                  <CardDescription>Create platform-wide announcements</CardDescription>
                </CardHeader>
              </Card>

              {/* Reports */}
              <Card className="group cursor-pointer transition-shadow hover:shadow-lg" onClick={() => router.push('/dashboard/admin/reports')}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <svg className="h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    <ArrowRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <CardTitle className="mt-4">System Reports</CardTitle>
                  <CardDescription>Generate and view system-wide reports</CardDescription>
                </CardHeader>
              </Card>
            </div>

            {/* Recent Activity Feed (moved to bottom for visual hierarchy) */}
            {recentActivity.length > 0 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Recent Activity</CardTitle>
                      <CardDescription>Most recent audit events across the platform</CardDescription>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard/admin/audit-logs')}>
                      View all <ArrowRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y">
                    {recentActivity.map((row) => (
                      <li key={row.id} className="py-2.5 flex items-start gap-3 text-sm">
                        <span className="mt-1 inline-block h-2 w-2 rounded-full bg-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="truncate">
                            <span className="font-medium">{row.user_name || 'System'}</span>
                            <span className="text-muted-foreground"> · </span>
                            <span className="font-mono text-xs text-muted-foreground">{row.action}</span>
                            {row.entity_type && (
                              <span className="text-muted-foreground"> on {row.entity_type}</span>
                            )}
                          </p>
                          {row.details && (
                            <p className="text-xs text-muted-foreground line-clamp-1">{row.details}</p>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(row.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          /* Regular User Dashboard */
          <div>
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-2">
                <p className="text-sm font-medium uppercase tracking-[0.25em] text-muted-foreground">
                  Your workspace
                </p>
                <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                  Your Projects
                </h1>
                <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
                  Choose from your existing projects below or create a new one
                </p>
              </div>

              <div className="flex gap-2">
                <Button onClick={() => setModalOpen(true)} variant="outline" className="gap-2">
                  <Building2 className="h-4 w-4" />
                  See Projects
                </Button>
                <Button onClick={() => router.push('/dashboard/new-project')} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create Project
                </Button>
              </div>
            </div>

            {projectsLoading && (
              <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-card/60 py-16 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
              </div>
            )}

            {!projectsLoading && projectsError && (
              <Card className="border-destructive/20 bg-destructive/5">
                <CardContent className="p-6 text-sm text-destructive">{projectsError}</CardContent>
              </Card>
            )}

            {!projectsLoading && !projectsError && projects.length === 0 && (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
                  <Building2 className="h-12 w-12 text-muted-foreground/60" />
                  <div className="space-y-2">
                    <h2 className="text-xl font-semibold">No projects assigned yet</h2>
                    <p className="max-w-md text-sm text-muted-foreground">
                      Create your first project to get started, then invite your team and begin tracking
                      progress.
                    </p>
                  </div>
                  <Button onClick={() => router.push('/dashboard/new-project')} className="gap-2">
                    <Plus className="h-4 w-4" />
                    Create New Project
                  </Button>
                </CardContent>
              </Card>
            )}

            {!projectsLoading && !projectsError && projects.length > 0 && (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {projects.map((project) => {
                    const progressPct = Math.min(
                      100,
                      Math.max(0, Number(project.overall_progress_pct ?? 0)) || 0,
                    )
                    const statusClass =
                      statusColors[project.status] ?? 'bg-muted text-muted-foreground'
                    const roleLabel = roleLabels[project.my_role] ?? 'Team member'
                    const dueDate = project.planned_end_date
                      ? new Date(project.planned_end_date).toLocaleDateString('en-US', {
                        month: 'short',
                        year: 'numeric',
                      })
                      : null

                    return (
                      <Card key={project.id} className="group overflow-hidden transition-shadow hover:shadow-lg">
                        <CardHeader className="space-y-4 pb-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <CardTitle className="truncate text-xl">{project.name}</CardTitle>
                              <CardDescription className="mt-1 flex items-center gap-2 text-sm">
                                <Badge variant="secondary" className={statusClass}>
                                  {String(project.status ?? 'unknown').replace('_', ' ')}
                                </Badge>
                                <span className="text-muted-foreground">{roleLabel}</span>
                              </CardDescription>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleOpenProject(project.id)}
                              aria-label={`Open ${project.name}`}
                            >
                              <ArrowRight className="h-4 w-4" />
                            </Button>
                          </div>

                          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1.5">
                              <MapPin className="h-3.5 w-3.5" />
                              {project.location || project.client_name || '—'}
                            </span>
                            {dueDate && (
                              <span className="flex items-center gap-1.5">
                                <Calendar className="h-3.5 w-3.5" />
                                {dueDate}
                              </span>
                            )}
                          </div>
                        </CardHeader>

                        <CardContent className="space-y-4 pt-0">
                          <div className="flex items-center gap-4 text-sm">
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <Users className="h-4 w-4 text-primary" />
                              {roleLabel}
                            </span>
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <TrendingUp className="h-4 w-4 text-accent" />
                              {progressPct.toFixed(1)}% complete
                            </span>
                          </div>

                          <div className="h-2 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${progressPct}%` }}
                            />
                          </div>

                          <Button
                            variant="outline"
                            className="w-full justify-between"
                            onClick={() => handleOpenProject(project.id)}
                          >
                            Open Project
                            <ArrowRight className="h-4 w-4" />
                          </Button>
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Project Selection Modal */}
      <ProjectSelectionModal open={modalOpen} onOpenChange={handleModalChange} />
    </div>
  )
}
