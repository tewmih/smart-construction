'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  GitBranch,
  Loader2,
  Pencil,
  PencilLine,
  Plus,
  Save,
  Trash2,
  UserCircle2,
  X,
  DollarSign,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
} from 'lucide-react'
import { getTask, updateTask, listProjectMembersEnriched, listProjectTasks, listTaskDependencies, addTaskDependency, removeTaskDependency, listTaskActivities, addTaskActivity, updateTaskActivity, deleteTaskActivity, getTaskBudgetSummary, deleteTask } from '@/lib/api'
import type { TaskListItem, EnrichedMemberRow, TaskActivityItem, TaskBudgetSummary } from '@/lib/api-types'
import type { TaskStatus } from '@/lib/domain'
import { useProjectRole } from '@/lib/project-role-context'
import { toast } from 'sonner'
import { useLanguage } from '@/lib/language-context'

interface TaskDetailPageProps {
  params: Promise<{ projectId: string; taskId: string }>
}

const statusConfig: Record<TaskStatus, { labelKey: string; className: string }> = {
  pending: { labelKey: 'tasksPage.pending', className: 'bg-slate-100 text-slate-700' },
  in_progress: { labelKey: 'tasksPage.inProgress', className: 'bg-blue-100 text-blue-700' },
  completed: { labelKey: 'tasksPage.completed', className: 'bg-emerald-100 text-emerald-700' },
}

export default function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { projectId, taskId } = use(params)
  const router = useRouter()
  const userRole = useProjectRole()
  const { t } = useLanguage()

  const [task, setTask] = useState<TaskListItem | null>(null)
  const [budgetSummary, setBudgetSummary] = useState<TaskBudgetSummary | null>(null)
  const [members, setMembers] = useState<EnrichedMemberRow[]>([])
  const [allTasks, setAllTasks] = useState<TaskListItem[]>([])
  const [deps, setDeps] = useState<{ id: string; task_id: string; depends_on_task_id: string }[]>([])
  const [activities, setActivities] = useState<TaskActivityItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [depAdding, setDepAdding] = useState(false)
  const [depPending, setDepPending] = useState<Set<string>>(new Set())
  const [newActName, setNewActName] = useState('')
  const [newActPct, setNewActPct] = useState('')
  const [addingAct, setAddingAct] = useState(false)
  const [editingActId, setEditingActId] = useState<string | null>(null)
  const [editActName, setEditActName] = useState('')
  const [editActPct, setEditActPct] = useState('')
  const [savingAct, setSavingAct] = useState(false)

  // Editable fields
  const [editName, setEditName] = useState('')
  const [editStatus, setEditStatus] = useState<TaskStatus>('pending')
  const [editProgress, setEditProgress] = useState('')
  const [editStartDate, setEditStartDate] = useState('')
  const [editEndDate, setEditEndDate] = useState('')
  const [editWeight, setEditWeight] = useState('')
  const [editAssignee, setEditAssignee] = useState<string | null>(null)
  const [assigneePopoverOpen, setAssigneePopoverOpen] = useState(false)

  const canEdit = userRole === 'project_manager'
  const canEditProgress = userRole === 'project_manager' || userRole === 'site_engineer'
  const usedActPct = activities.reduce((s, a) => s + a.percentage, 0)
  const remainingActPct = parseFloat((100 - usedActPct).toFixed(2))

  useEffect(() => {
    let cancelled = false
      ; (async () => {
        setLoading(true)
        setError(null)
        try {
          const [t, m, tasksRes, d, acts, budget] = await Promise.all([
            getTask(taskId),
            listProjectMembersEnriched(projectId),
            listProjectTasks(projectId, { limit: 200 }),
            listTaskDependencies(taskId).catch(() => []),
            listTaskActivities(taskId).catch(() => []),
            getTaskBudgetSummary(taskId).catch(() => null),
          ])
          if (cancelled) return
          setTask(t)
          setMembers(m)
          setAllTasks(tasksRes.data.filter(tk => tk.id !== taskId))
          setDeps(d)
          setActivities(acts)
          setBudgetSummary(budget)
          setEditName(t.title)
          setEditStatus(t.status)
          setEditProgress(String(t.progress_percentage))
          setEditStartDate(t.start_date ? t.start_date.split('T')[0] : '')
          setEditEndDate(t.end_date ? t.end_date.split('T')[0] : '')
          setEditWeight(String(t.weight ?? 0))
          setEditAssignee(t.assigned_to ?? null)
        } catch {
          if (!cancelled) setError(t('taskDetailPage.taskNotFound'))
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    return () => { cancelled = true }
  }, [taskId, projectId])

  const handleSave = async () => {
    setSaving(true)
    try {
      // Site engineer can only update progress; PM can update everything
      const body = canEdit
        ? {
          name: editName.trim() || undefined,
          status: editStatus,
          progress_percentage: Number.parseFloat(editProgress) || 0,
          start_date: editStartDate ? `${editStartDate}T00:00:00` : undefined,
          end_date: editEndDate ? `${editEndDate}T00:00:00` : undefined,
          weight: Number.parseFloat(editWeight) || 0,
          assigned_to: editAssignee || undefined,
        }
        : {
          progress_percentage: Number.parseFloat(editProgress) || 0,
        }
      await updateTask(taskId, body)
      // Reload
      const taskRes = await getTask(taskId)
      setTask(taskRes)
      setEditing(false)
      toast.success(t('taskDetailPage.taskUpdated'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('taskDetailPage.failedToUpdate'))
    } finally {
      setSaving(false)
    }
  }

  const selectedMember = members.find(m => m.user.id === editAssignee)

  if (loading) {
    return (
      <div className="flex justify-center py-24 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  if (error || !task) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
        <p>{error || t('taskDetailPage.taskNotFound')}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.back()}>
          {t('taskDetailPage.goBack')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6 px-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push(`/dashboard/${projectId}/tasks`)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{task.title}</h1>
          <p className="text-sm text-muted-foreground">{t('taskDetailPage.subtitle')}</p>
        </div>
        <Badge className={statusConfig[task.status]?.className}>
          {t(statusConfig[task.status]?.labelKey)}
        </Badge>
        {(canEdit || canEditProgress) && (
          editing ? (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => {
              setEditing(false)
              setEditName(task.title)
              setEditStatus(task.status)
              setEditProgress(String(task.progress_percentage))
              setEditStartDate(task.start_date ? task.start_date.split('T')[0] : '')
              setEditEndDate(task.end_date ? task.end_date.split('T')[0] : '')
              setEditWeight(String(task.weight ?? 0))
              setEditAssignee(task.assigned_to ?? null)
            }}>
              <X className="h-4 w-4" />
              {t('taskDetailPage.cancel')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setEditing(true)}>
              <PencilLine className="h-4 w-4" />
              {canEdit ? t('taskDetailPage.edit') : t('taskDetailPage.updateProgress')}
            </Button>
          )
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.6fr_0.9fr]">
        <div className="space-y-6">
          {/* Task Information */}
          <Card>
            <CardHeader>
              <CardTitle>{t('taskDetailPage.information')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label>{t('taskDetailPage.name')}</Label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={!editing}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t('taskDetailPage.status')}</Label>
                  <Select value={editStatus} onValueChange={(v) => setEditStatus(v as TaskStatus)} disabled={!editing}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">{t('tasksPage.pending')}</SelectItem>
                      <SelectItem value="in_progress">{t('tasksPage.inProgress')}</SelectItem>
                      <SelectItem value="completed">{t('tasksPage.completed')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t('taskDetailPage.weight')}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={editWeight}
                    onChange={(e) => setEditWeight(e.target.value)}
                    disabled={!editing || !canEdit}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('taskDetailPage.weightDesc')}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('taskDetailPage.progress')}</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={editProgress}
                  onChange={(e) => setEditProgress(e.target.value)}
                  disabled={!editing}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t('taskDetailPage.startDate')}</Label>
                  <Input
                    type="date"
                    value={editStartDate}
                    onChange={(e) => setEditStartDate(e.target.value)}
                    disabled={!editing}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('taskDetailPage.endDate')}</Label>
                  <Input
                    type="date"
                    value={editEndDate}
                    onChange={(e) => setEditEndDate(e.target.value)}
                    disabled={!editing}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('taskDetailPage.assignTo')}</Label>
                <Popover open={assigneePopoverOpen} onOpenChange={setAssigneePopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" type="button" className="w-full justify-start gap-2 font-normal" disabled={!editing}>
                      {selectedMember ? (
                        <>
                          <Avatar className="h-5 w-5">
                            <AvatarFallback className="text-[10px]">
                              {selectedMember.user.full_name.split(' ').filter(p => p).map(p => p[0]).join('').toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          {selectedMember.user.full_name}
                        </>
                      ) : (
                        <>
                          <UserCircle2 className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">{t('taskDetailPage.unassigned')}</span>
                        </>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-1" align="start">
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted"
                      onClick={() => { setEditAssignee(null); setAssigneePopoverOpen(false) }}
                    >
                      <UserCircle2 className="h-6 w-6 text-muted-foreground" />
                      <span>{t('taskDetailPage.unassigned')}</span>
                    </button>
                    <div className="max-h-48 overflow-y-auto">
                      {members.map((m) => {
                        const initials = m.user.full_name.split(' ').filter(p => p).map(p => p[0]).join('').toUpperCase() || 'U'
                        return (
                          <button
                            key={m.user.id}
                            type="button"
                            className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted ${editAssignee === m.user.id ? 'bg-muted' : ''}`}
                            onClick={() => { setEditAssignee(m.user.id); setAssigneePopoverOpen(false) }}
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

              {editing && (
                <div className="flex justify-end pt-2">
                  <Button onClick={() => void handleSave()} disabled={saving} className="gap-2">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {t('taskDetailPage.saveChanges')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>


          {/* Dependencies */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <GitBranch className="h-4 w-4" />
                  {t('taskDetailPage.dependencies')}
                </CardTitle>
                {canEdit && !depAdding && (
                  <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => setDepAdding(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('tasksPage.addActivity').replace(/Activity|ክንዋኔ/i, '') || 'Add'}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {depAdding && (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('taskDetailPage.mustCompleteBefore')}</p>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {allTasks
                      .filter(t => !deps.some(d => d.depends_on_task_id === t.id))
                      .map(t => (
                        <button
                          key={t.id}
                          type="button"
                          disabled={depPending.has(t.id)}
                          className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                          onClick={async () => {
                            setDepPending(prev => new Set(prev).add(t.id))
                            try {
                              await addTaskDependency(taskId, t.id)
                              const d = await listTaskDependencies(taskId).catch(() => [])
                              setDeps(d)
                              toast.success(`Dependency added: ${t.title}`)
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : 'Failed to add dependency')
                            } finally {
                              setDepPending(prev => { const s = new Set(prev); s.delete(t.id); return s })
                            }
                          }}
                        >
                          <span>{t.title}</span>
                          <Badge variant="outline" className="text-[10px]">{t.status}</Badge>
                        </button>
                      ))}
                    {allTasks.filter(t => !deps.some(d => d.depends_on_task_id === t.id)).length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-2">{t('taskDetailPage.noAvailableTasks')}</p>
                    )}
                  </div>
                  <Button variant="outline" size="sm" className="w-full" onClick={() => setDepAdding(false)}>
                    {t('taskDetailPage.done')}
                  </Button>
                </div>
              )}

              {deps.length === 0 && !depAdding && (
                <p className="text-xs text-muted-foreground text-center py-2">{t('taskDetailPage.noDependencies')}</p>
              )}

              {deps.map((dep) => {
                const blockerTask = allTasks.find(t => t.id === dep.depends_on_task_id)
                return (
                  <div key={dep.id} className="flex items-center justify-between rounded-lg border p-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">{blockerTask?.title ?? dep.depends_on_task_id.slice(0, 8)}</span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] shrink-0 ${blockerTask?.status === 'completed'
                          ? 'border-emerald-300 text-emerald-700'
                          : 'border-amber-300 text-amber-700'
                          }`}
                      >
                        {blockerTask?.status === 'completed' ? t('taskDetailPage.done') : t('taskDetailPage.blocking')}
                      </Badge>
                    </div>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={async () => {
                          await removeTaskDependency(taskId, dep.id)
                          setDeps(prev => prev.filter(d => d.id !== dep.id))
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )
              })}
            </CardContent>
          </Card>

          {/* Activities */}
          <Card>
            <CardHeader>
              <CardTitle>{t('taskDetailPage.activities')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {activities.map((act) => (
                <div key={act.id} className="space-y-1">
                  <div className="flex items-center justify-between rounded-lg border p-2.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <button
                        type="button"
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded border transition-colors ${act.is_completed ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 hover:border-emerald-400'}`}
                        onClick={async () => {
                          try {
                            await updateTaskActivity(taskId, act.id, { is_completed: !act.is_completed })
                            setActivities(prev => prev.map(a => a.id === act.id ? { ...a, is_completed: !a.is_completed } : a))
                            const t = await getTask(taskId)
                            setTask(t)
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : 'Failed to update')
                          }
                        }}
                      >
                        {act.is_completed && <CheckCircle2 className="h-3 w-3" />}
                      </button>
                      <span className={`text-sm truncate ${act.is_completed ? 'line-through text-muted-foreground' : ''}`}>{act.name}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Badge variant="outline" className="text-[10px]">{act.percentage}%</Badge>
                      {canEdit && (
                        <>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground"
                            onClick={() => { setEditingActId(act.id); setEditActName(act.name); setEditActPct(String(act.percentage)) }}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={async () => {
                              try {
                                await deleteTaskActivity(taskId, act.id)
                                setActivities(prev => prev.filter(a => a.id !== act.id))
                                const t = await getTask(taskId)
                                setTask(t)
                                toast.success('Activity removed')
                              } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
                            }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {editingActId === act.id && (
                    <div className="space-y-2 rounded-lg border bg-muted/30 p-2">
                      <div className="grid grid-cols-[1fr_80px] gap-2">
                        <Input className="h-7 text-sm" value={editActName} onChange={e => setEditActName(e.target.value)} placeholder={t('taskDetailPage.activityName')} />
                        <Input className="h-7 text-sm" type="number" min={1} max={100} value={editActPct} onChange={e => setEditActPct(e.target.value)} placeholder="%" />
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditingActId(null)}>{t('taskDetailPage.cancel')}</Button>
                        <Button size="sm" className="h-7 px-2 text-xs" disabled={savingAct || !editActName.trim()}
                          onClick={async () => {
                            setSavingAct(true)
                            try {
                              const updated = await updateTaskActivity(taskId, act.id, {
                                name: editActName.trim(),
                                percentage: Number(editActPct) || act.percentage,
                              })
                              setActivities(prev => prev.map(a => a.id === act.id ? updated : a))
                              const t = await getTask(taskId)
                              setTask(t)
                              setEditingActId(null)
                              toast.success('Activity updated')
                            } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
                            finally { setSavingAct(false) }
                          }}>
                          {savingAct ? <Loader2 className="h-3 w-3 animate-spin" /> : t('taskDetailPage.saveChanges')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {activities.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-2">{t('taskDetailPage.noActivities')}</p>
              )}
              {canEdit && usedActPct >= 100 && (
                <p className="text-xs text-center text-muted-foreground rounded-lg border border-dashed py-2">
                  {t('taskDetailPage.allocated100')}
                </p>
              )}
              {canEdit && usedActPct < 100 && (
                <div className="rounded-lg border p-3 space-y-2">
                  <div className="grid grid-cols-[1fr_80px] gap-2">
                    <Input placeholder={t('taskDetailPage.activityName')} value={newActName} onChange={(e) => setNewActName(e.target.value)} className="h-8 text-sm" />
                    <Input type="number" min={1} max={remainingActPct} placeholder="%" value={newActPct} onChange={(e) => setNewActPct(e.target.value)} className="h-8 text-sm" />
                  </div>
                  <p className="text-xs text-muted-foreground">{t('taskDetailPage.leaveEmptyAuto').replace('{pct}', String(remainingActPct))}</p>
                  <Button size="sm" className="w-full gap-1" disabled={addingAct || !newActName.trim()}
                    onClick={async () => {
                      setAddingAct(true)
                      try {
                        let percentage = newActPct ? Number(newActPct) : null
                        if (percentage === null) {
                          percentage = Math.max(0, parseFloat((100 - activities.reduce((s, a) => s + a.percentage, 0)).toFixed(2)))
                        }
                        const created = await addTaskActivity(taskId, { name: newActName.trim(), percentage })
                        setActivities(prev => [...prev, created])
                        setNewActName('')
                        setNewActPct('')
                        const t = await getTask(taskId)
                        setTask(t)
                        toast.success('Activity added')
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : 'Failed')
                      } finally {
                        setAddingAct(false)
                      }
                    }}>
                    {addingAct ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    {t('taskDetailPage.addActivity')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right sidebar */}
        <div className="space-y-6">
          {/* Budget Card */}
          {budgetSummary ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <DollarSign className="h-4 w-4" />
                  {t('taskDetailPage.budget')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('taskDetailPage.allocated')}</span>
                    <span className="font-medium">ETB {budgetSummary.allocated_budget.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('taskDetailPage.spent')}</span>
                    <span className={`font-medium ${budgetSummary.status === 'over_budget' ? 'text-red-600' : ''}`}>
                      ETB {budgetSummary.total_spent.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('taskDetailPage.remaining')}</span>
                    <span className={`font-semibold ${budgetSummary.remaining_budget < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      ETB {budgetSummary.remaining_budget.toLocaleString()}
                    </span>
                  </div>
                  <Progress
                    value={Math.min(budgetSummary.budget_utilization_pct, 100)}
                    className={`h-2 ${budgetSummary.status === 'over_budget'
                      ? '[&>div]:bg-red-500'
                      : budgetSummary.status === 'on_budget'
                        ? '[&>div]:bg-amber-500'
                        : '[&>div]:bg-emerald-500'
                      }`}
                  />
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {t('taskDetailPage.used').replace('{pct}', budgetSummary.budget_utilization_pct.toFixed(1))}
                    </span>
                    {budgetSummary.status === 'over_budget' && (
                      <span className="flex items-center gap-1 text-red-600">
                        <AlertTriangle className="h-3 w-3" />
                        {t('taskDetailPage.overBudget')}
                      </span>
                    )}
                    {budgetSummary.status === 'on_budget' && (
                      <span className="flex items-center gap-1 text-amber-600">
                        <TrendingUp className="h-3 w-3" />
                        {t('taskDetailPage.nearLimit')}
                      </span>
                    )}
                    {budgetSummary.status === 'under_budget' && (
                      <span className="flex items-center gap-1 text-emerald-600">
                        <TrendingDown className="h-3 w-3" />
                        {t('taskDetailPage.onTrack')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="space-y-1 pt-2 border-t">
                  <p className="text-xs font-medium text-muted-foreground">{t('taskDetailPage.costBreakdown')}</p>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{t('taskDetailPage.labor')}</span>
                    <span>ETB {budgetSummary.spent_labor.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{t('taskDetailPage.materials')}</span>
                    <span>ETB {budgetSummary.spent_materials.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{t('taskDetailPage.equipment')}</span>
                    <span>ETB {budgetSummary.spent_equipment.toLocaleString()}</span>
                  </div>
                  <p className="text-xs text-muted-foreground pt-1">
                    {t('taskDetailPage.fromLogs').replace('{count}', String(budgetSummary.log_count))}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : task.allocated_budget ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <DollarSign className="h-4 w-4" />
                  {t('taskDetailPage.budget')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('taskDetailPage.allocated')}</span>
                  <span className="font-medium">ETB {task.allocated_budget.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('taskDetailPage.spent')}</span>
                  <span className="font-medium">ETB 0</span>
                </div>
                <Progress value={0} className="h-2" />
                <p className="text-xs text-muted-foreground text-center pt-1">{t('taskDetailPage.noExpenses')}</p>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('taskDetailPage.completion')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('taskDetailPage.completion')}</span>
                  <span className="font-medium">{task.progress_percentage}%</span>
                </div>
                <Progress
                  value={task.progress_percentage}
                  className={`h-2 ${task.status === 'completed' ? '[&>div]:bg-emerald-500' : ''}`}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('taskDetailPage.timeline')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{t('taskDetailPage.startDate')}:</span>
                <span>{task.start_date ? new Date(task.start_date).toLocaleDateString() : t('taskDetailPage.notSet')}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{t('taskDetailPage.endDate')}:</span>
                <span>{task.end_date ? new Date(task.end_date).toLocaleDateString() : t('taskDetailPage.notSet')}</span>
              </div>
            </CardContent>
          </Card>

          {task.assignee && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('taskDetailPage.assignedTo')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs">
                      {task.assignee.full_name.split(' ').filter(p => p).map(p => p[0]).join('').toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-medium">{task.assignee.full_name}</p>
                    <p className="text-xs text-muted-foreground">{task.assignee.email}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Delete Task - Danger Zone */}
          {canEdit && (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-base text-destructive">{t('taskDetailPage.dangerZone')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Button
                  variant="destructive"
                  className="w-full gap-2"
                  onClick={async () => {
                    if (!confirm(t('taskDetailPage.confirmDelete'))) return
                    try {
                      await deleteTask(taskId)
                      toast.success(t('taskDetailPage.taskDeleted'))
                      router.push(`/dashboard/${projectId}/tasks`)
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'Failed to delete task')
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  {t('taskDetailPage.deleteTask')}
                </Button>
                <p className="text-xs text-muted-foreground mt-2 text-center">
                  {t('taskDetailPage.cannotBeUndone')}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div >
  )
}
