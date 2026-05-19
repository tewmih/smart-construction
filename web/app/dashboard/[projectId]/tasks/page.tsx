'use client'

import { use, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Circle,
  Pencil,
  Plus,
  Search,
  TriangleAlert,
  Loader2,
  UserCircle2,
  X,
} from 'lucide-react'
import { useProjectRole } from '@/lib/project-role-context'
import { useAuth } from '@/lib/auth-context'
import type { TaskListItem, EnrichedMemberRow } from '@/lib/api-types'
import type { TaskStatus } from '@/lib/domain'
import { createTask, updateTask, listProjectTasks, listProjectMembersEnriched, addTaskActivity } from '@/lib/api'
import { toast } from 'sonner'
import { useLanguage } from '@/lib/language-context'

interface TasksPageProps {
  params: Promise<{ projectId: string }>
}

const statusConfig: Record<TaskStatus, { labelKey: string; className: string }> = {
  pending: { labelKey: 'tasksPage.pending', className: 'bg-slate-100 text-slate-700' },
  in_progress: { labelKey: 'tasksPage.inProgress', className: 'bg-blue-100 text-blue-700' },
  completed: { labelKey: 'tasksPage.completed', className: 'bg-emerald-100 text-emerald-700' },
}

const PAGE_SIZE = 4
const statusFilters = ['all', 'completed', 'in_progress', 'pending'] as const

function timelineLabel(start?: string | null, end?: string | null) {
  if (!start || !end) return 'No dates set'
  const startDate = new Date(start)
  const endDate = new Date(end)
  return `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

function estimateHours(start?: string | null, end?: string | null) {
  if (!start || !end) return 0
  const diffMs = Math.max(new Date(end).getTime() - new Date(start).getTime(), 0)
  return Math.round((diffMs / (1000 * 60 * 60 * 24)) * 8)
}

export default function TasksPage({ params }: TasksPageProps) {
  const { projectId } = use(params)
  const userRole = useProjectRole()
  const { t } = useLanguage()
  const { user } = useAuth()

  const [projectTasks, setProjectTasks] = useState<TaskListItem[]>([])
  const [loading, setLoading] = useState(true)

  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(1)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTaskName, setNewTaskName] = useState('')
  const today = new Date().toISOString().split('T')[0]
  const [newTaskStart, setNewTaskStart] = useState(today)
  const [newTaskDuration, setNewTaskDuration] = useState('7')
  const [newTaskWeight, setNewTaskWeight] = useState('1.0')
  const [newTaskAssignee, setNewTaskAssignee] = useState<string | null>(null)
  const [newTaskDependsOn, setNewTaskDependsOn] = useState<string | null>(null)
  const [assigneePopoverOpen, setAssigneePopoverOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [members, setMembers] = useState<EnrichedMemberRow[]>([])

  // Activities for new task
  const [newTaskActivities, setNewTaskActivities] = useState<Array<{ name: string; percentage: string }>>([
    { name: '', percentage: '' }
  ])

  const canCreateTask = userRole === 'project_manager'

  const loadTasks = async () => {
    setLoading(true)
    try {
      const taskRes = await listProjectTasks(projectId, {
        limit: 100,
        assigned_to: userRole === 'site_engineer' ? user?.id : undefined,
      })
      setProjectTasks(taskRes.data)
    } catch {
      setProjectTasks([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTasks()
    listProjectMembersEnriched(projectId).then(setMembers).catch(() => setMembers([]))
  }, [projectId])

  // Update default weight when dialog opens or tasks change
  useEffect(() => {
    if (newTaskOpen) {
      const totalUsed = projectTasks.reduce((sum, t) => sum + (t.weight || 0), 0)
      const remaining = Math.max(0, 100 - totalUsed)
      setNewTaskWeight(remaining > 0 ? remaining.toFixed(1) : '0')
    }
  }, [newTaskOpen, projectTasks])

  const handleCreateTask = async () => {
    if (!newTaskName.trim()) {
      toast.error(t('tasksPage.taskNameRequired'))
      return
    }
    if (!newTaskWeight || Number(newTaskWeight) <= 0) {
      toast.error(t('tasksPage.weightRequired'))
      return
    }

    // Calculate total weight of existing tasks
    const existingWeight = projectTasks.reduce((sum, t) => sum + (t.weight || 0), 0)
    const newWeight = Number(newTaskWeight)
    const totalWeight = existingWeight + newWeight

    if (totalWeight > 100) {
      toast.error(
        t('tasksPage.weightExceedErr')
          .replace('{current}', existingWeight.toFixed(1))
          .replace('{adding}', newWeight.toFixed(1))
          .replace('{total}', totalWeight.toFixed(1))
      )
      return
    }

    // Validate activities - only require name, percentage is optional
    const activitiesWithNames = newTaskActivities.filter(a => a.name.trim())
    if (activitiesWithNames.length === 0) {
      toast.error(t('tasksPage.activityRequired'))
      return
    }

    // Auto-distribute percentages
    // 1. Calculate total of activities with custom percentages
    const activitiesWithCustomPercent = activitiesWithNames.filter(a => a.percentage.trim())
    const customPercentTotal = activitiesWithCustomPercent.reduce((sum, a) => sum + Number(a.percentage), 0)

    // 2. Calculate remaining percentage for activities without custom percentages
    const activitiesWithoutPercent = activitiesWithNames.filter(a => !a.percentage.trim())
    const remainingPercent = 100 - customPercentTotal

    // 3. Distribute remaining percentage equally
    const equalShare = activitiesWithoutPercent.length > 0
      ? remainingPercent / activitiesWithoutPercent.length
      : 0

    // 4. Build final activities list with calculated percentages
    const finalActivities = activitiesWithNames.map(a => ({
      name: a.name.trim(),
      percentage: a.percentage.trim() ? Number(a.percentage) : equalShare
    }))

    // 5. Validate total is 100% (with small tolerance for rounding)
    const totalPercentage = finalActivities.reduce((sum, a) => sum + a.percentage, 0)
    if (Math.abs(totalPercentage - 100) > 0.1) {
      toast.error(t('tasksPage.activitySumErr').replace('{current}', totalPercentage.toFixed(1)))
      return
    }

    setCreating(true)
    setCreateError(null)
    try {
      const created = await createTask(projectId, {
        name: newTaskName.trim(),
        start_date: newTaskStart ? `${newTaskStart}T00:00:00` : undefined,
        duration_days: Number(newTaskDuration) || 7,
        weight: Number(newTaskWeight),
        assigned_to: newTaskAssignee || undefined,
        depends_on_task_id: newTaskDependsOn || undefined,
      })

      // Add activities to the created task
      const taskId = (created as any).id
      if (taskId) {
        for (const activity of finalActivities) {
          try {
            await addTaskActivity(taskId, {
              name: activity.name,
              percentage: activity.percentage,
            })
          } catch (e) {
            console.error('Failed to add activity:', e)
          }
        }
      }

      setNewTaskOpen(false)
      setNewTaskName('')
      setNewTaskStart(today)
      setNewTaskDuration('7')
      setNewTaskWeight('1.0')
      setNewTaskAssignee(null)
      setNewTaskDependsOn(null)
      setNewTaskActivities([{ name: '', percentage: '' }])
      await loadTasks()
      toast.success(t('tasksPage.createdSuccess'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('tasksPage.failedToCreate')
      setCreateError(msg)
      toast.error(msg)
    } finally {
      setCreating(false)
    }
  }

  const filteredTasks = useMemo(() => {
    return [...projectTasks]
      .reverse() // newest first (backend returns in insertion order)
      .filter((task) => {
        if (statusFilter !== 'all' && task.status !== statusFilter) return false
        if (searchQuery && !task.title.toLowerCase().includes(searchQuery.toLowerCase())) return false
        return true
      })
  }, [projectTasks, searchQuery, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filteredTasks.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * PAGE_SIZE
  const pageTasks = filteredTasks.slice(pageStart, pageStart + PAGE_SIZE)

  const inProgressCount = projectTasks.filter((task) => task.status === 'in_progress').length
  const pendingCount = projectTasks.filter((task) => task.status === 'pending').length
  const completedCount = projectTasks.filter((task) => task.status === 'completed').length

  // Calculate total weight and remaining weight
  const totalUsedWeight = projectTasks.reduce((sum, t) => sum + (t.weight || 0), 0)
  const remainingWeight = Math.max(0, 100 - totalUsedWeight)

  const statusChipLabel: Record<(typeof statusFilters)[number], string> = {
    all: t('auditLogsPage.all'),
    completed: t('tasksPage.completed'),
    in_progress: t('tasksPage.inProgress'),
    pending: t('tasksPage.pending'),
  }

  const statusChipClass: Record<(typeof statusFilters)[number], string> = {
    all: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
    completed: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200',
    in_progress: 'bg-blue-100 text-blue-700 hover:bg-blue-200',
    pending: 'bg-amber-100 text-amber-700 hover:bg-amber-200',
  }

  if (loading) {
    return (
      <div className="flex justify-center py-24 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-5 px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('tasksPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('tasksPage.subtitle')}</p>
        </div>

        {canCreateTask && (
          <Dialog open={newTaskOpen} onOpenChange={setNewTaskOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                {t('tasksPage.createTask')}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('tasksPage.createNewTask')}</DialogTitle>
                <DialogDescription>
                  {t('tasksPage.addTaskDesc')}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-2 max-h-[60vh] overflow-y-auto pr-2">
                <div className="grid gap-2">
                  <label className="text-sm font-medium" htmlFor="task-name">{t('tasksPage.taskName')}</label>
                  <Input
                    id="task-name"
                    placeholder={t('tasksPage.taskNamePlaceholder')}
                    value={newTaskName}
                    onChange={(e) => setNewTaskName(e.target.value)}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t('tasksPage.dependsOn')}</label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={newTaskDependsOn ?? ''}
                    onChange={(e) => {
                      const depId = e.target.value || null
                      setNewTaskDependsOn(depId)
                      if (depId) {
                        const depTask = projectTasks.find(t => t.id === depId)
                        if (depTask?.end_date) {
                          const endDate = new Date(depTask.end_date)
                          endDate.setDate(endDate.getDate() + 1)
                          // Skip weekends
                          while (endDate.getDay() === 0 || endDate.getDay() === 6) {
                            endDate.setDate(endDate.getDate() + 1)
                          }
                          setNewTaskStart(endDate.toISOString().split('T')[0])
                        }
                      }
                    }}
                  >
                    <option value="">{t('tasksPage.noDependency')}</option>
                    {projectTasks
                      .filter(t => t.status !== 'completed')
                      .map(t => (
                        <option key={t.id} value={t.id}>
                          {t.title} ({t.status.replace('_', ' ')})
                        </option>
                      ))}
                  </select>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <label className="text-sm font-medium" htmlFor="task-start">{t('tasksPage.startDate')}</label>
                    <Input
                      id="task-start"
                      type="date"
                      value={newTaskStart}
                      onChange={(e) => setNewTaskStart(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium" htmlFor="task-duration">{t('tasksPage.duration')}</label>
                    <Input
                      id="task-duration"
                      type="number"
                      min={1}
                      max={365}
                      placeholder="7"
                      value={newTaskDuration}
                      onChange={(e) => setNewTaskDuration(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium" htmlFor="task-weight">
                    {t('tasksPage.weight')}
                    <span className="ml-1 text-xs text-muted-foreground">
                      {t('tasksPage.remaining').replace('{count}', remainingWeight.toFixed(1))}
                    </span>
                  </label>
                  <Input
                    id="task-weight"
                    type="number"
                    min={0.1}
                    max={remainingWeight}
                    step={0.1}
                    placeholder={remainingWeight.toFixed(1)}
                    value={newTaskWeight}
                    onChange={(e) => setNewTaskWeight(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('tasksPage.weightDesc')}
                  </p>
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t('tasksPage.assignTo')}</label>
                  <Popover open={assigneePopoverOpen} onOpenChange={setAssigneePopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" type="button" className="justify-start gap-2 font-normal">
                        {newTaskAssignee ? (
                          <>
                            <Avatar className="h-5 w-5">
                              <AvatarFallback className="text-[10px]">
                                {members.find(m => m.user.id === newTaskAssignee)?.user.full_name
                                  .split(' ').filter(p => p).map(p => p[0]).join('').toUpperCase() || 'U'}
                              </AvatarFallback>
                            </Avatar>
                            {members.find(m => m.user.id === newTaskAssignee)?.user.full_name || 'Unknown'}
                          </>
                        ) : (
                          <>
                            <UserCircle2 className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">{t('tasksPage.unassigned')}</span>
                          </>
                        )}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-1" align="start">
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted"
                        onClick={() => { setNewTaskAssignee(null); setAssigneePopoverOpen(false) }}
                      >
                        <UserCircle2 className="h-6 w-6 text-muted-foreground" />
                        <span>{t('tasksPage.unassigned')}</span>
                      </button>
                      <div className="max-h-48 overflow-y-auto">
                        {members.map((m) => {
                          const initials = m.user.full_name.split(' ').filter(p => p).map(p => p[0]).join('').toUpperCase() || 'U'
                          return (
                            <button
                              key={m.user.id}
                              type="button"
                              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted ${newTaskAssignee === m.user.id ? 'bg-muted' : ''}`}
                              onClick={() => { setNewTaskAssignee(m.user.id); setAssigneePopoverOpen(false) }}
                            >
                              <Avatar className="h-6 w-6">
                                <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                              </Avatar>
                              <div className="text-left">
                                <p className="font-medium">{m.user.full_name}</p>
                                {m.user.email && <p className="text-xs text-muted-foreground">{m.user.email}</p>}
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t('tasksPage.activities')}</label>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {newTaskActivities.map((activity, index) => (
                      <div key={index} className="flex gap-2">
                        <Input
                          placeholder={t('tasksPage.activityName')}
                          value={activity.name}
                          onChange={(e) => {
                            const updated = [...newTaskActivities]
                            updated[index].name = e.target.value
                            setNewTaskActivities(updated)
                          }}
                          className="flex-1"
                        />
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          placeholder="%"
                          value={activity.percentage}
                          onChange={(e) => {
                            const updated = [...newTaskActivities]
                            updated[index].percentage = e.target.value
                            setNewTaskActivities(updated)
                          }}
                          className="w-20"
                        />
                        {newTaskActivities.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0"
                            onClick={() => {
                              setNewTaskActivities(newTaskActivities.filter((_, i) => i !== index))
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div className="text-xs text-muted-foreground">
                      {(() => {
                        const activitiesWithNames = newTaskActivities.filter(a => a.name.trim())
                        const activitiesWithCustomPercent = activitiesWithNames.filter(a => a.percentage.trim())
                        const customPercentTotal = activitiesWithCustomPercent.reduce((sum, a) => sum + Number(a.percentage), 0)
                        const activitiesWithoutPercent = activitiesWithNames.filter(a => !a.percentage.trim())
                        const remainingPercent = 100 - customPercentTotal
                        const equalShare = activitiesWithoutPercent.length > 0 ? remainingPercent / activitiesWithoutPercent.length : 0

                        const customTotal = activitiesWithCustomPercent.reduce((sum, a) => sum + Number(a.percentage), 0)
                        const autoTotal = activitiesWithoutPercent.length * equalShare
                        const total = customTotal + autoTotal

                        return (
                          <div>
                            <p>{t('tasksPage.total').replace('{pct}', total.toFixed(1))}</p>
                            {activitiesWithoutPercent.length > 0 && (
                              <p className="text-[10px] text-emerald-600">
                                {t('tasksPage.auto')
                                  .replace('{count}', String(activitiesWithoutPercent.length))
                                  .replace('{pct}', equalShare.toFixed(1))
                                  .replace('{total}', autoTotal.toFixed(1))}
                              </p>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1"
                      onClick={() => setNewTaskActivities([...newTaskActivities, { name: '', percentage: '' }])}
                    >
                      <Plus className="h-3 w-3" />
                      {t('tasksPage.addActivity')}
                    </Button>
                  </div>
                </div>

                {createError && (
                  <p className="text-sm text-destructive">{createError}</p>
                )}
              </div>

              <DialogFooter className="sticky bottom-0 bg-background pt-4 border-t">
                <Button variant="outline" onClick={() => setNewTaskOpen(false)}>{t('tasksPage.cancel')}</Button>
                <Button onClick={handleCreateTask} disabled={creating || !newTaskName.trim() || !newTaskWeight} className="gap-2">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {t('tasksPage.createTask')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => { setStatusFilter('all'); setSearchQuery('') }}>
          {t('tasksPage.clearFilters')}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('tasksPage.scopeCoverage')}</p>
            <p className="text-4xl font-semibold leading-none">{totalUsedWeight.toFixed(1)}<span className="text-lg text-muted-foreground">%</span></p>
            <div className="space-y-1">
              <Progress value={totalUsedWeight} className="h-2" />
              <p className="text-xs text-muted-foreground">
                {t('tasksPage.notInTask').replace('{pct}', remainingWeight.toFixed(1))}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('tasksPage.inProgress')}</p>
              <Circle className="h-2 w-2 fill-blue-600 text-blue-600" />
            </div>
            <p className="text-4xl font-semibold leading-none">{inProgressCount.toString().padStart(2, '0')}</p>
            <p className="text-xs text-blue-700">{t('tasksPage.activeCycle')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('tasksPage.pending')}</p>
            <p className="text-4xl font-semibold leading-none text-amber-600">{pendingCount.toString().padStart(2, '0')}</p>
            <p className="flex items-center gap-1 text-xs text-amber-600">
              <TriangleAlert className="h-3.5 w-3.5" />
              {t('tasksPage.awaitingStart')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('tasksPage.completed')}</p>
            <p className="text-4xl font-semibold leading-none">{completedCount.toString().padStart(2, '0')}</p>
            <p className="text-xs text-emerald-700">{t('tasksPage.done')}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {statusFilters.map((filter) => (
                <Button
                  key={filter}
                  variant={statusFilter === filter ? 'default' : 'secondary'}
                  size="sm"
                  className={statusFilter === filter ? 'gap-2' : `gap-2 ${statusChipClass[filter]}`}
                  onClick={() => {
                    setStatusFilter(filter)
                    setPage(1)
                  }}
                >
                  {statusChipLabel[filter]}
                </Button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-80">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value)
                    setPage(1)
                  }}
                  placeholder={t('tasksPage.searchPlaceholder')}
                  className="h-9 pl-9"
                />
              </div>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('tasksPage.taskDetails')}</TableHead>
                <TableHead>{t('tasksPage.assignee')}</TableHead>
                <TableHead>{t('tasksPage.status')}</TableHead>
                <TableHead>{t('tasksPage.durationLabel')}</TableHead>
                <TableHead>{t('tasksPage.completion')}</TableHead>
                <TableHead>{t('tasksPage.weightLabel')}</TableHead>
                <TableHead>{t('tasksPage.activitiesLabel')}</TableHead>
                <TableHead className="text-right">{t('tasksPage.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageTasks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                    {t('tasksPage.noTasks')}
                  </TableCell>
                </TableRow>
              ) : (
                pageTasks.map((task) => {
                  const progress = task.progress_percentage
                  const durationDays = task.start_date && task.end_date
                    ? Math.ceil((new Date(task.end_date).getTime() - new Date(task.start_date).getTime()) / (1000 * 60 * 60 * 24))
                    : 0

                  return (
                    <TableRow key={task.id}>
                      <TableCell>
                        <p className="font-medium">{task.title}</p>
                      </TableCell>

                      <TableCell>
                        <Popover>
                          <PopoverTrigger asChild>
                            <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted transition-colors cursor-pointer">
                              {task.assignee ? (
                                <>
                                  <Avatar className="h-6 w-6">
                                    <AvatarFallback className="text-[10px]">
                                      {task.assignee.full_name.split(' ').filter(p => p).map(p => p[0]).join('').toUpperCase() || 'U'}
                                    </AvatarFallback>
                                  </Avatar>
                                  <span className="text-sm">{task.assignee.full_name}</span>
                                </>
                              ) : (
                                <>
                                  <UserCircle2 className="h-5 w-5 text-muted-foreground" />
                                  <span className="text-sm text-muted-foreground">{t('tasksPage.unassigned')}</span>
                                </>
                              )}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-64 p-1" align="start">
                            <button
                              type="button"
                              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted"
                              onClick={async () => {
                                try {
                                  await updateTask(task.id, {})
                                  // Update in-place to avoid reorder
                                  setProjectTasks(prev => prev.map(t => t.id === task.id ? { ...t, assigned_to: null, assignee: null } : t))
                                  toast.success(t('tasksPage.unassignedSuccess'))
                                } catch (e) {
                                  toast.error(e instanceof Error ? e.message : t('tasksPage.failedToUnassign'))
                                }
                              }}
                            >
                              <UserCircle2 className="h-6 w-6 text-muted-foreground" />
                              <span>{t('tasksPage.unassigned')}</span>
                            </button>
                            <div className="max-h-48 overflow-y-auto">
                              {members.map((m) => {
                                const ini = m.user.full_name.split(' ').filter(p => p).map(p => p[0]).join('').toUpperCase() || 'U'
                                return (
                                  <button
                                    key={m.user.id}
                                    type="button"
                                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted ${task.assigned_to === m.user.id ? 'bg-muted' : ''}`}
                                    onClick={async () => {
                                      try {
                                        await updateTask(task.id, { assigned_to: m.user.id })
                                        // Update in-place to avoid reorder
                                        setProjectTasks(prev => prev.map(t => t.id === task.id ? { ...t, assigned_to: m.user.id, assignee: { id: m.user.id, full_name: m.user.full_name, email: m.user.email || '' } } : t))
                                        toast.success(t('tasksPage.assignedTo').replace('{name}', m.user.full_name))
                                      } catch (e) {
                                        toast.error(e instanceof Error ? e.message : t('tasksPage.failedToAssign'))
                                      }
                                    }}
                                  >
                                    <Avatar className="h-6 w-6">
                                      <AvatarFallback className="text-[10px]">{ini}</AvatarFallback>
                                    </Avatar>
                                    <div className="text-left">
                                      <p className="font-medium">{m.user.full_name}</p>
                                      {m.user.email && <p className="text-xs text-muted-foreground">{m.user.email}</p>}
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                          </PopoverContent>
                        </Popover>
                      </TableCell>

                      <TableCell>
                        <Badge className={statusConfig[task.status]?.className ?? 'bg-slate-100 text-slate-700'}>
                          {t(statusConfig[task.status]?.labelKey) ?? task.status}
                        </Badge>
                      </TableCell>

                      <TableCell>
                        <p className="text-sm">{durationDays > 0 ? `${durationDays} ${t('tasksPage.days')}` : '—'}</p>
                        {task.start_date && task.end_date && (
                          <p className="text-xs text-muted-foreground">
                            {new Date(task.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - {new Date(task.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </p>
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="w-28 space-y-1">
                          <p className="text-xs font-medium">{progress.toFixed(1)}%</p>
                          <Progress
                            value={progress}
                            className={`h-1.5 ${task.status === 'completed' ? '[&>div]:bg-emerald-500' : ''}`}
                          />
                        </div>
                      </TableCell>

                      <TableCell>
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                          {(task.weight ?? 0).toFixed(1)}%
                        </span>
                      </TableCell>

                      <TableCell>
                        <span className="inline-flex items-center gap-1 text-sm">
                          {task.activity_count ?? 0}
                        </span>
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" asChild>
                            <a href={`/dashboard/${projectId}/tasks/${task.id}`}>
                              {t('tasksPage.view')} <ArrowUpRight className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>

          <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground">
              {t('tasksPage.showingTasks')
                .replace('{start}', String(Math.min(filteredTasks.length, pageStart + 1)))
                .replace('{end}', String(Math.min(filteredTasks.length, pageStart + PAGE_SIZE)))
                .replace('{total}', String(filteredTasks.length))}
            </p>

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={safePage <= 1}
                onClick={() => setPage((prev) => Math.max(prev - 1, 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              {[...Array(totalPages)].map((_, index) => {
                const pageNumber = index + 1
                return (
                  <Button
                    key={pageNumber}
                    variant={pageNumber === safePage ? 'default' : 'outline'}
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPage(pageNumber)}
                  >
                    {pageNumber}
                  </Button>
                )
              })}

              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={safePage >= totalPages}
                onClick={() => setPage((prev) => Math.min(prev + 1, totalPages))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
