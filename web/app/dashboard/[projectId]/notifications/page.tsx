'use client'

import { use, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ClipboardList,
  DollarSign,
  Info,
  ListTodo,
  Loader2,
  Megaphone,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import { getProject, listMessages, markMessageRead } from '@/lib/api'
import type { MessageRow, MessageType, ProjectDetail } from '@/lib/api-types'
import { useProjectRole } from '@/lib/project-role-context'

interface NotificationsPageProps {
  params: Promise<{ projectId: string }>
}

type NotificationFilter = 'all' | 'unread'

type NotificationItem = {
  id: string
  content: string
  time: string
  unread: boolean
  type: string | null
  entity_type: string | null
  entity_id: string | null
  project_id: string | null
}

function formatTime(iso: string) {
  const d = new Date(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return 'Just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} minutes ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} hours ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function mapRow(row: MessageRow): NotificationItem {
  return {
    id: row.id,
    content: row.content,
    time: formatTime(row.created_at),
    unread: !row.is_read,
    type: row.type ?? null,
    entity_type: row.entity_type ?? null,
    entity_id: row.entity_id ?? null,
    project_id: row.project_id ?? null,
  }
}

const TYPE_VISUALS: Record<MessageType, { icon: LucideIcon; tone: string }> = {
  log_submitted: { icon: ClipboardList, tone: 'bg-amber-50 border-amber-200 text-amber-700' },
  log_consultant_approved: { icon: ClipboardList, tone: 'bg-indigo-50 border-indigo-200 text-indigo-700' },
  log_approved: { icon: ClipboardList, tone: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  log_rejected: { icon: ClipboardList, tone: 'bg-red-50 border-red-200 text-red-700' },
  task_assigned: { icon: ListTodo, tone: 'bg-blue-50 border-blue-200 text-blue-700' },
  member_added: { icon: UserPlus, tone: 'bg-violet-50 border-violet-200 text-violet-700' },
  invitation: { icon: UserPlus, tone: 'bg-violet-50 border-violet-200 text-violet-700' },
  announcement: { icon: Megaphone, tone: 'bg-sky-50 border-sky-200 text-sky-700' },
  risk_alert: { icon: AlertTriangle, tone: 'bg-orange-50 border-orange-200 text-orange-700' },
  budget_alert: { icon: DollarSign, tone: 'bg-rose-50 border-rose-200 text-rose-700' },
}

function visualsFor(type: string | null) {
  if (type && type in TYPE_VISUALS) return TYPE_VISUALS[type as MessageType]
  return { icon: Bell, tone: 'bg-slate-50 border-slate-200 text-slate-700' }
}

function deepLink(item: NotificationItem, fallbackProjectId: string): string | null {
  const projectId = item.project_id || fallbackProjectId
  if (!item.entity_type || !item.entity_id) return null
  switch (item.entity_type) {
    case 'daily_log':
      return `/dashboard/${projectId}/logs/${item.entity_id}`
    case 'task':
      return `/dashboard/${projectId}/tasks/${item.entity_id}`
    case 'project':
      return `/dashboard/${item.entity_id}`
    default:
      return null
  }
}

function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <Button
      variant={active ? 'default' : 'secondary'}
      size="sm"
      className="h-9 rounded-full px-4"
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

export default function NotificationsPage({ params }: NotificationsPageProps) {
  const { projectId } = use(params)
  const userRole = useProjectRole()
  const router = useRouter()
  const [filter, setFilter] = useState<NotificationFilter>('all')
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [marking, setMarking] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [proj, msgRes] = await Promise.all([
          getProject(projectId),
          listMessages({ limit: 100 }),
        ])
        if (cancelled) return
        setProject(proj)
        setItems(msgRes.data.map(mapRow))
      } catch {
        if (!cancelled) {
          setProject(null)
          setItems([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  const filteredNotifications = useMemo(() => {
    return items.filter((item) => {
      if (filter === 'unread') return item.unread
      return true
    })
  }, [filter, items])

  const unreadCount = items.filter((item) => item.unread).length

  const handleMarkAllRead = async () => {
    setMarking(true)
    try {
      const unreadItems = items.filter((i) => i.unread)
      await Promise.all(unreadItems.map((i) => markMessageRead(i.id)))
      setItems((prev) => prev.map((i) => ({ ...i, unread: false })))
    } catch {
      // silent
    } finally {
      setMarking(false)
    }
  }

  const handleMarkRead = async (id: string) => {
    try {
      await markMessageRead(id)
      setItems((prev) => prev.map((i) => i.id === id ? { ...i, unread: false } : i))
    } catch {
      // silent
    }
  }

  const handleClickItem = async (item: NotificationItem) => {
    if (item.unread) {
      await handleMarkRead(item.id)
    }
    const href = deepLink(item, projectId)
    if (href) router.push(href)
  }

  if (loading || !project) {
    return (
      <div className="flex justify-center py-24 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
            <Badge className="rounded-full bg-blue-100 text-blue-700 hover:bg-blue-100">{unreadCount} unread</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Project {project.name} - role {userRole.replace(/_/g, ' ')}
          </p>
        </div>

        <Button
          variant="outline"
          className="gap-2 self-start shadow-sm"
          disabled={marking || unreadCount === 0}
          onClick={() => void handleMarkAllRead()}
        >
          <CheckCircle2 className="h-4 w-4" />
          Mark all as read
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterChip>
        <FilterChip active={filter === 'unread'} onClick={() => setFilter('unread')}>Unread</FilterChip>
      </div>

      <div className="space-y-4">
        {filteredNotifications.map((notification) => {
          const { icon: Icon, tone } = visualsFor(notification.type)
          const hasLink = deepLink(notification, projectId) !== null
          return (
            <Card
              key={notification.id}
              className={`overflow-hidden border shadow-sm transition-shadow hover:shadow-md cursor-pointer ${notification.unread ? 'border-l-4 border-l-blue-600' : ''}`}
              onClick={() => void handleClickItem(notification)}
            >
              <CardContent className="p-0">
                <div className="flex items-start gap-4 p-4 sm:p-5">
                  <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl border ${tone}`}>
                    <Icon className="h-5 w-5" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <p className="text-sm leading-6 text-foreground">{notification.content}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">{notification.time}</span>
                        {notification.unread ? <span className="h-2.5 w-2.5 rounded-full bg-blue-700" /> : null}
                      </div>
                    </div>
                    {hasLink && (
                      <p className="mt-1 text-xs text-muted-foreground">Click to open</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {filteredNotifications.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-14 text-center">
            <Info className="mb-3 h-10 w-10 text-muted-foreground/60" />
            <h2 className="text-base font-medium">No notifications</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {filter === 'unread' ? 'All messages are read.' : 'No messages yet.'}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
