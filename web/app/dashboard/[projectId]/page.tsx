'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  BarChart3,
  Calendar,
  Clock3,
  CloudRain,
  HardHat,
  Loader2,
  Package,
  Settings,
  TrendingDown,
  TrendingUp,
  Truck,
  Wallet,
  FileText,
} from 'lucide-react'
import { useProjectRole } from '@/lib/project-role-context'
import { useCurrency } from '@/lib/currency-context'
import { getComprehensiveAnalytics, getPrediction, getProject, getProjectBudget, getWeather, listProjectLogs, listProjectTasks } from '@/lib/api'
import type { BudgetSummary, ComprehensiveAnalytics, LogListItem, PredictionResponse, ProjectDetail, TaskListItem, WeatherResponse } from '@/lib/api-types'
import { WeatherForecastCard } from '@/components/weather-forecast-card'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  XAxis,
  YAxis,
} from 'recharts'

interface DashboardPageProps {
  params: Promise<{ projectId: string }>
}


function getIssueTag(log: LogListItem) {
  const remark = (log.notes || '').toLowerCase()

  if (remark.includes('weather') || remark.includes('rain')) {
    return { label: 'Weather Hold', className: 'bg-blue-100 text-blue-700' }
  }

  if (log.status === 'submitted') {
    return { label: 'Pending Review', className: 'bg-amber-100 text-amber-700' }
  }

  return { label: 'None', className: 'bg-slate-100 text-slate-600' }
}

type MlFeatureValues = {
  cost_deviation?: number | null
  time_deviation?: number | null
  task_progress?: number | null
  equipment_utilization_rate?: number | null
  worker_count?: number | null
  material_usage?: number | null
  temperature?: number | null
  humidity?: number | null
  machinery_status?: number | null
}

type MlProbabilityValues = {
  low?: number
  medium?: number
  high?: number
  critical?: number
}

type RiskDriver = {
  label: string
  value: string
  tone: 'ok' | 'warning' | 'critical'
  detail: string
}

function toFiniteNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function splitRecommendationItems(text: string) {
  return text
    .replace(/\r/g, '\n')
    .split(/\n+|•|;/)
    .map((part) => part.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

function formatCompactAmount(value: number) {
  const absolute = Math.abs(value)
  const sign = value < 0 ? '-' : ''

  if (absolute >= 1_000_000) {
    return `${sign}${(absolute / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}m`
  }

  if (absolute >= 1_000) {
    return `${sign}${(absolute / 1_000).toFixed(absolute >= 10_000 ? 0 : 1)}k`
  }

  return `${sign}${absolute.toLocaleString()}`
}

type AnalyticsTone = 'good' | 'warning' | 'critical' | 'neutral'

const toneStyles: Record<AnalyticsTone, { card: string; badge: string; valueText: string }> = {
  good: {
    card: 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/40 dark:bg-emerald-950/20',
    badge: 'bg-emerald-100 text-emerald-700',
    valueText: 'text-emerald-700 dark:text-emerald-300',
  },
  warning: {
    card: 'border-amber-200 bg-amber-50/40 dark:border-amber-900/40 dark:bg-amber-950/20',
    badge: 'bg-amber-100 text-amber-700',
    valueText: 'text-amber-700 dark:text-amber-300',
  },
  critical: {
    card: 'border-red-200 bg-red-50/40 dark:border-red-900/40 dark:bg-red-950/20',
    badge: 'bg-red-100 text-red-700',
    valueText: 'text-red-700 dark:text-red-300',
  },
  neutral: {
    card: 'border-slate-200 bg-slate-50/40 dark:border-slate-800 dark:bg-slate-900/30',
    badge: 'bg-slate-100 text-slate-700',
    valueText: 'text-slate-800 dark:text-slate-200',
  },
}

function statusTone(status: string | undefined): AnalyticsTone {
  switch (status) {
    case 'healthy':
    case 'efficient':
    case 'excellent':
    case 'minimal':
      return 'good'
    case 'warning':
    case 'moderate':
    case 'inefficient':
      return 'warning'
    case 'critical':
    case 'significant':
      return 'critical'
    default:
      return 'neutral'
  }
}

export default function DashboardPage({ params }: DashboardPageProps) {
  const { projectId } = use(params)
  const userRole = useProjectRole()
  const { formatBudget } = useCurrency()

  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [tasks, setTasks] = useState<TaskListItem[]>([])
  const [logs, setLogs] = useState<LogListItem[]>([])
  const [prediction, setPrediction] = useState<PredictionResponse | null>(null)
  const [analytics, setAnalytics] = useState<ComprehensiveAnalytics | null>(null)
  const [budgetSummary, setBudgetSummary] = useState<BudgetSummary | null>(null)
  const [weather, setWeather] = useState<WeatherResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [predictionOpen, setPredictionOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
      ; (async () => {
        setLoading(true)
        try {
          // Only fetch prediction + analytics for Project Managers to speed up load.
          // Analytics returns the prediction inside it, so the dedicated prediction call
          // is only kept as a quick fallback when comprehensive fails.
          const predictionPromise =
            userRole === 'project_manager'
              ? getPrediction(projectId).catch(() => null)
              : Promise.resolve<PredictionResponse | null>(null)
          const analyticsPromise =
            userRole === 'project_manager'
              ? getComprehensiveAnalytics(projectId).catch(() => null)
              : Promise.resolve<ComprehensiveAnalytics | null>(null)

          const [projectResult, budgetResult, tasksResult, logsResult, weatherResult, predictionResult, analyticsResult] =
            await Promise.all([
              getProject(projectId),
              getProjectBudget(projectId).catch(() => null),
              listProjectTasks(projectId, { limit: 100 }),
              listProjectLogs(projectId, { limit: 100 }),
              getWeather(projectId).catch(() => null),
              predictionPromise,
              analyticsPromise,
            ] as const)

          if (cancelled) return
          setProject(projectResult)
          setBudgetSummary(budgetResult)
          setTasks(tasksResult.data ?? [])
          setLogs(logsResult.data ?? [])
          setWeather(weatherResult)
          setPrediction(predictionResult)
          setAnalytics(analyticsResult)
        } catch {
          if (!cancelled) {
            setProject(null)
            setBudgetSummary(null)
            setTasks([])
            setLogs([])
            setAnalytics(null)
          }
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    return () => {
      cancelled = true
    }
  }, [projectId, userRole])

  if (loading || !project) {
    return (
      <div className="flex justify-center py-24 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  const isProjectManager = userRole === 'project_manager'

  const totalBudget = project.total_budget
  const totalSpent = project.budget_spent
  const remaining = Math.max(totalBudget - totalSpent, 0)
  const spentPct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0
  const totalReceived = budgetSummary?.total_received ?? 0
  const receivedPct = totalBudget > 0 ? Math.round((totalReceived / totalBudget) * 100) : 0
  const remainingReceived = Math.max(totalBudget - totalReceived, 0)
  const additionalDays = prediction?.delay_estimate_days ?? 0
  const additionalBudget = Math.max(0, prediction?.budget_overrun_estimate ?? 0)
  const totalProjectAfterPrediction = totalBudget + additionalBudget
  const budgetRisePct = totalBudget > 0 ? Math.round((additionalBudget / totalBudget) * 100) : 0

  const pendingApprovals = logs.filter((log) =>
    ['submitted', 'consultant_approved'].includes(log.status),
  ).length

  // Calculate project completion live from tasks (avoids stale backend value)
  // Formula: Σ(task.progress_percentage / 100 * task.weight)
  // A task with weight=1.9 that is 100% done contributes 1.9 to the total
  const liveProjectCompletion = tasks.reduce(
    (sum, t) => sum + (t.progress_percentage || 0) / 100.0 * (t.weight || 0),
    0
  )
  const overallCompletion = clamp(liveProjectCompletion, 0, 100)

  const predictionReason = typeof prediction?.reason === 'string' ? prediction.reason : ''
  const predictionRecommendation =
    typeof prediction?.recommendation === 'string' ? prediction.recommendation : ''
  const recommendationItems = splitRecommendationItems(predictionRecommendation)

  const recentLogs = [...logs]
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .slice(0, 5)
  const visibleRecentLogs = isProjectManager || userRole === 'consultant'
    ? recentLogs.filter((log) => log.status !== 'draft')
    : recentLogs

  return (
    <div className="space-y-6">
      {/* Header with Action Buttons */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{project.name}</h2>
          <p className="text-sm text-muted-foreground">{project.location}</p>
        </div>
        <div className="flex items-center gap-2">
          {userRole === 'site_engineer' && (
            <Link href={`/dashboard/${projectId}/logs/create`}>
              <Button className="gap-2">
                <FileText className="h-4 w-4" />
                Create Daily Log
              </Button>
            </Link>
          )}
          {isProjectManager && (
            <Link href={`/dashboard/${projectId}/edit`}>
              <Button variant="outline" className="gap-2">
                <Settings className="h-4 w-4" />
                Edit Project
              </Button>
            </Link>
          )}
        </div>
      </div>

      <div className={`grid gap-4 ${isProjectManager ? 'xl:grid-cols-2' : 'xl:grid-cols-1'}`}>
        <Card className="shadow-sm border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Project Progress & Budget</CardTitle>
            <CardDescription>Progress, spend, and client funding in one simple view</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 rounded-xl border bg-muted/20 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-foreground">Overall project completion</span>
                <span className="font-semibold text-foreground">{overallCompletion.toFixed(1)}%</span>
              </div>
              <Progress value={overallCompletion} className="h-3" />
              <p className="text-xs text-muted-foreground">
                {overallCompletion > 75
                  ? 'Project is moving well.'
                  : overallCompletion > 40
                    ? 'Project is progressing steadily.'
                    : 'Project needs more attention.'}
              </p>
            </div>

            {isProjectManager && (
              <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground">Spend budget</span>
                    <span className="font-semibold text-foreground">{spentPct.toFixed(1)}%</span>
                  </div>
                  <Progress value={spentPct} className="h-3" />
                  <p className="text-xs text-muted-foreground">
                    {formatBudget(totalSpent)} spent from {formatBudget(totalBudget)}.
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Budget remaining</span>
                    <span>{formatBudget(remaining)} / {formatBudget(totalBudget)}</span>
                  </div>
                  <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                    <div
                      className="bg-emerald-500"
                      style={{ width: `${clamp(100 - spentPct, 0, 100)}%` }}
                    />
                    <div className="bg-slate-200 dark:bg-slate-700" style={{ width: `${clamp(spentPct, 0, 100)}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{formatBudget(remaining)} remaining</span>
                    <span>{formatBudget(totalSpent)} spent</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Received from client</span>
                    <span>{formatBudget(totalReceived)} / {formatBudget(totalBudget)}</span>
                  </div>
                  <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                    <div
                      className="bg-emerald-500"
                      style={{ width: `${clamp(receivedPct, 0, 100)}%` }}
                    />
                    <div className="bg-slate-200 dark:bg-slate-700" style={{ width: `${100 - clamp(receivedPct, 0, 100)}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{formatBudget(totalReceived)} received</span>
                    <span>{formatBudget(remainingReceived)} left to receive</span>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {isProjectManager && (
          <Card className="shadow-sm border bg-card">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <Bot className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-base">AI Risk Prediction</CardTitle>
                    <CardDescription>Simple prediction summary and detail view</CardDescription>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {prediction ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border bg-blue-50 p-4 shadow-sm dark:bg-blue-950/20">
                      <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Estimated additional day</p>
                      <p className="mt-2 text-3xl font-bold text-blue-900 dark:text-blue-100">{additionalDays}</p>
                      <p className="mt-1 text-xs text-blue-700/80 dark:text-blue-200/80">Days of extra time expected.</p>
                    </div>
                    <div className="rounded-xl border bg-amber-50 p-4 shadow-sm dark:bg-amber-950/20">
                      <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Estimated additional budget</p>
                      <p className="mt-2 text-3xl font-bold text-amber-900 dark:text-amber-100">Birr {formatCompactAmount(additionalBudget)}</p>
                      <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-200/80">Extra cost impact on the plan.</p>
                    </div>
                  </div>

                  <div className="rounded-xl border bg-muted/20 p-4 shadow-sm">
                    <p className="text-sm font-medium text-foreground">
                      {additionalDays > 0
                        ? `The plan may delay by ${additionalDays} day(s).`
                        : 'No extra delay is predicted.'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Open the detail view for the full explanation and recommendations.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">
                  No prediction available yet.
                </p>
              )}

              {/* View Details Button */}
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => setPredictionOpen(true)}
              >
                View Detailed Analysis
                <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* AI Prediction Details Modal */}
        <Dialog open={predictionOpen} onOpenChange={setPredictionOpen}>
          <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                AI Risk Prediction - Detailed Analysis
              </DialogTitle>
              <DialogDescription>
                Clean summary of risk, delay, budget impact, and recommendations
              </DialogDescription>
            </DialogHeader>

            {prediction && (() => {
              const riskColors: Record<string, { bg: string; label: string; value: string }> = {
                low: {
                  bg: 'bg-emerald-50 dark:bg-emerald-950/20',
                  label: 'text-emerald-700 dark:text-emerald-300',
                  value: 'text-emerald-900 dark:text-emerald-100',
                },
                medium: {
                  bg: 'bg-amber-50 dark:bg-amber-950/20',
                  label: 'text-amber-700 dark:text-amber-300',
                  value: 'text-amber-900 dark:text-amber-100',
                },
                high: {
                  bg: 'bg-orange-50 dark:bg-orange-950/20',
                  label: 'text-orange-700 dark:text-orange-300',
                  value: 'text-orange-900 dark:text-orange-100',
                },
                critical: {
                  bg: 'bg-red-50 dark:bg-red-950/20',
                  label: 'text-red-700 dark:text-red-300',
                  value: 'text-red-900 dark:text-red-100',
                },
              }
              const rc = riskColors[prediction.risk_level] ?? riskColors.medium
              return (
                <div className="space-y-4 py-4 pr-1 sm:pr-2">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className={`rounded-xl border p-4 shadow-sm ${rc.bg}`}>
                      <p className={`text-xs font-semibold uppercase tracking-wide ${rc.label}`}>Risk level</p>
                      <p className={`mt-2 text-2xl font-bold ${rc.value}`}>
                        {prediction.risk_level.replace(/_/g, ' ')}
                      </p>
                    </div>
                    <div className="rounded-xl border bg-blue-50 p-4 shadow-sm dark:bg-blue-950/20">
                      <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Estimated additional day</p>
                      <p className="mt-2 text-3xl font-bold text-blue-900 dark:text-blue-100">{additionalDays}</p>
                    </div>
                    <div className="rounded-xl border bg-amber-50 p-4 shadow-sm dark:bg-amber-950/20">
                      <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Estimated additional budget</p>
                      <p className="mt-2 text-3xl font-bold text-amber-900 dark:text-amber-100">Birr {formatCompactAmount(additionalBudget)}</p>
                    </div>
                  </div>

                  {additionalDays > 0 && predictionReason.trim() && (
                    <div className="space-y-3 rounded-xl border bg-muted/20 p-4 shadow-sm">
                      <p className="text-sm font-semibold text-foreground">Delay reason</p>
                      <p className="text-sm text-muted-foreground">
                        The plan will delay in {additionalDays} day(s) because {predictionReason}.
                      </p>
                    </div>
                  )}

                  <div className="space-y-3 rounded-xl border bg-muted/20 p-4 shadow-sm">
                    <p className="text-sm font-semibold text-foreground">Budget impact</p>
                    {additionalBudget > 0 ? (
                      <p className="text-sm text-muted-foreground">
                        You will spend Birr {formatCompactAmount(additionalBudget)} more. The project total cost will rise by {budgetRisePct}% and it will total Birr {formatCompactAmount(totalProjectAfterPrediction)}.
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">No extra budget cost is predicted at the moment.</p>
                    )}
                  </div>

                  <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      <p className="text-sm font-semibold text-foreground">Recommendations</p>
                    </div>
                    {recommendationItems.length > 0 ? (
                      <ul className="space-y-2 text-sm text-muted-foreground">
                        {recommendationItems.map((item) => (
                          <li key={item} className="flex gap-2">
                            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">No recommendation text is available yet.</p>
                    )}
                  </div>

                  {/* Delay Breakdown */}
                  {analytics?.delay_breakdown && analytics.delay_breakdown.total_delay_days > 0 && (
                    <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-foreground">Delay breakdown</p>
                        <span className="text-xs text-muted-foreground">
                          {analytics.delay_breakdown.total_delay_days} day{analytics.delay_breakdown.total_delay_days === 1 ? '' : 's'} total
                        </span>
                      </div>
                      <ul className="space-y-2">
                        {analytics.delay_breakdown.breakdown.map((item) => (
                          <li key={item.cause} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-medium text-foreground">{item.cause}</span>
                              <span className="text-muted-foreground">
                                {item.days} day{item.days === 1 ? '' : 's'} · {item.percentage.toFixed(0)}%
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full bg-primary"
                                style={{ width: `${clamp(item.percentage, 0, 100)}%` }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )
            })()}
          </DialogContent>
        </Dialog>
      </div>

      {isProjectManager && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            <div>
              <h3 className="text-lg font-semibold">Project Analytics</h3>
              <p className="text-sm text-muted-foreground">Operational health across schedule, cost, equipment, weather, labor, and materials.</p>
            </div>
          </div>

          {!analytics ? (
            <Card className="shadow-sm">
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Analytics unavailable. Submit and approve daily logs to populate these metrics.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {/* Schedule Health — radial gauge (100 = on target = full arc) */}
              {(() => {
                const m = analytics.schedule_health
                const tone = statusTone(m.status)
                const t = toneStyles[tone]
                const toneFill = tone === 'good' ? '#10b981' : tone === 'warning' ? '#f59e0b' : tone === 'critical' ? '#ef4444' : '#64748b'
                const planningPhase = project?.status === 'planning'
                const gaugeValue = clamp(m.index, 0, 100)
                const overage = Math.max(0, m.index - 100)
                return (
                  <Card className={`shadow-sm border ${t.card}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          <CardTitle className="text-sm font-semibold">Schedule Health</CardTitle>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${t.badge}`}>
                          {planningPhase ? 'planning' : m.status}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {planningPhase ? (
                        <div className="flex h-36 flex-col items-center justify-center gap-1 text-center">
                          <Calendar className="h-8 w-8 text-muted-foreground/40" />
                          <p className="text-sm font-medium text-foreground">Planning phase</p>
                          <p className="text-xs text-muted-foreground">Work hasn't started yet</p>
                        </div>
                      ) : (
                        <>
                          <ChartContainer config={{ index: { label: 'Index', color: toneFill } }} className="mx-auto h-36 w-full">
                            <RadialBarChart data={[{ name: 'index', value: gaugeValue, fill: toneFill }]} startAngle={210} endAngle={-30} innerRadius={48} outerRadius={70}>
                              <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                              <RadialBar dataKey="value" background={{ fill: '#e5e7eb' }} cornerRadius={6} />
                              <text
                                x="50%" y="50%"
                                textAnchor="middle" dominantBaseline="middle"
                                className={`fill-current text-2xl font-bold ${t.valueText}`}
                              >
                                {m.index.toFixed(0)}%
                              </text>
                              {overage > 0 && (
                                <text
                                  x="50%" y="68%"
                                  textAnchor="middle" dominantBaseline="middle"
                                  className="fill-emerald-600 text-[10px] font-semibold"
                                >
                                  +{overage.toFixed(0)} ahead
                                </text>
                              )}
                            </RadialBarChart>
                          </ChartContainer>
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>Actual {m.actual_progress.toFixed(1)}%</span>
                            <span>Expected {m.expected_progress.toFixed(1)}%</span>
                          </div>
                          <p className="text-xs text-muted-foreground">{m.message}</p>
                        </>
                      )}
                    </CardContent>
                  </Card>
                )
              })()}

              {/* Budget Efficiency — progress vs budget bars */}
              {(() => {
                const m = analytics.budget_efficiency
                const planningPhase = project?.status === 'planning'
                const tone = planningPhase ? 'neutral' : statusTone(m.status)
                const t = toneStyles[tone]
                const data = [
                  { name: 'Progress', value: m.progress_pct, fill: '#10b981' },
                  { name: 'Budget used', value: m.budget_consumed_pct, fill: '#f59e0b' },
                ]
                // Dynamic max so over-100 values stay legible without dwarfing under-100 ones.
                const dataMax = Math.max(m.progress_pct, m.budget_consumed_pct)
                const xMax = dataMax <= 100 ? 100 : Math.ceil((dataMax * 1.1) / 10) * 10
                return (
                  <Card className={`shadow-sm border ${t.card}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Wallet className="h-4 w-4 text-muted-foreground" />
                          <CardTitle className="text-sm font-semibold">Budget Efficiency</CardTitle>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${t.badge}`}>
                          {planningPhase ? 'planning' : m.status}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {planningPhase ? (
                        <div className="flex h-36 flex-col items-center justify-center gap-1 text-center">
                          <Wallet className="h-8 w-8 text-muted-foreground/40" />
                          <p className="text-sm font-medium text-foreground">Planning phase</p>
                          <p className="text-xs text-muted-foreground">No progress or spending yet</p>
                        </div>
                      ) : (
                        <>
                          <ChartContainer
                            config={{ value: { label: 'Percent' } }}
                            className="h-36 w-full"
                          >
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 32, top: 4, bottom: 4 }}>
                              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                              <XAxis type="number" domain={[0, xMax]} tickFormatter={(v) => `${v}%`} hide />
                              <YAxis type="category" dataKey="name" width={86} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                              <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                              <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={20}>
                                {data.map((entry) => <Cell key={entry.name} fill={entry.fill} />)}
                              </Bar>
                            </BarChart>
                          </ChartContainer>
                          <p className="text-center text-xs text-muted-foreground">
                            Efficiency score <span className={`font-semibold ${t.valueText}`}>{m.efficiency.toFixed(0)}</span> · {m.message}
                          </p>
                        </>
                      )}
                    </CardContent>
                  </Card>
                )
              })()}

              {/* Equipment Productivity — donut */}
              {(() => {
                const m = analytics.equipment_productivity
                const tone = statusTone(m.status)
                const t = toneStyles[tone]
                const data = [
                  { name: 'Productive', value: Math.max(0, m.productive_hours), fill: '#10b981' },
                  { name: 'Idle', value: Math.max(0, m.idle_hours), fill: '#ef4444' },
                ]
                const hasData = data.some((d) => d.value > 0)
                return (
                  <Card className={`shadow-sm border ${t.card}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Truck className="h-4 w-4 text-muted-foreground" />
                          <CardTitle className="text-sm font-semibold">Equipment Productivity</CardTitle>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${t.badge}`}>
                          {m.status.replace('_', ' ')}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {hasData ? (
                        <ChartContainer
                          config={{ Productive: { label: 'Productive', color: '#10b981' }, Idle: { label: 'Idle', color: '#ef4444' } }}
                          className="mx-auto h-36 w-full"
                        >
                          <PieChart>
                            <ChartTooltip content={<ChartTooltipContent />} />
                            <Pie data={data} dataKey="value" nameKey="name" innerRadius={42} outerRadius={62} paddingAngle={2}>
                              {data.map((entry) => <Cell key={entry.name} fill={entry.fill} />)}
                            </Pie>
                            <text
                              x="50%" y="50%"
                              textAnchor="middle" dominantBaseline="middle"
                              className={`fill-current text-xl font-bold ${t.valueText}`}
                            >
                              {m.utilization_rate.toFixed(0)}%
                            </text>
                          </PieChart>
                        </ChartContainer>
                      ) : (
                        <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">No equipment data</div>
                      )}
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{m.productive_hours.toFixed(0)}h productive</span>
                        <span>{m.idle_hours.toFixed(0)}h idle</span>
                      </div>
                      {m.idle_cost_estimate > 0 && (
                        <p className="text-center text-xs text-muted-foreground">Idle cost ≈ {formatBudget(m.idle_cost_estimate)}</p>
                      )}
                    </CardContent>
                  </Card>
                )
              })()}

              {/* Weather Impact — donut: lost vs available */}
              {(() => {
                const m = analytics.weather_impact
                const tone = statusTone(m.status)
                const t = toneStyles[tone]
                const remaining = Math.max(0, m.total_available_hours - m.hours_lost)
                const data = [
                  { name: 'Hours lost', value: Math.max(0, m.hours_lost), fill: '#3b82f6' },
                  { name: 'Worked', value: remaining, fill: '#e5e7eb' },
                ]
                const hasData = data.some((d) => d.value > 0)
                return (
                  <Card className={`shadow-sm border ${t.card}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CloudRain className="h-4 w-4 text-muted-foreground" />
                          <CardTitle className="text-sm font-semibold">Weather Impact</CardTitle>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${t.badge}`}>
                          {m.status}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {hasData ? (
                        <ChartContainer
                          config={{ 'Hours lost': { label: 'Lost', color: '#3b82f6' }, Worked: { label: 'Worked', color: '#e5e7eb' } }}
                          className="mx-auto h-36 w-full"
                        >
                          <PieChart>
                            <ChartTooltip content={<ChartTooltipContent />} />
                            <Pie data={data} dataKey="value" nameKey="name" innerRadius={42} outerRadius={62} paddingAngle={2} startAngle={90} endAngle={-270}>
                              {data.map((entry) => <Cell key={entry.name} fill={entry.fill} />)}
                            </Pie>
                            <text
                              x="50%" y="50%"
                              textAnchor="middle" dominantBaseline="middle"
                              className={`fill-current text-xl font-bold ${t.valueText}`}
                            >
                              {m.impact_percentage.toFixed(1)}%
                            </text>
                          </PieChart>
                        </ChartContainer>
                      ) : (
                        <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">No data</div>
                      )}
                      <p className="text-center text-xs text-muted-foreground">
                        {m.hours_lost.toFixed(0)}h lost over last {m.days_analyzed} days
                      </p>
                    </CardContent>
                  </Card>
                )
              })()}

              {/* Labor Productivity — line chart of recent logs */}
              {(() => {
                const m = analytics.labor_productivity
                const tone: AnalyticsTone =
                  m.trend === 'improving' ? 'good' :
                    m.trend === 'declining' ? 'critical' :
                      'neutral'
                const t = toneStyles[tone]
                const TrendIcon = m.trend === 'declining' ? TrendingDown : TrendingUp
                // Backend returns most-recent first; reverse for left-to-right time axis.
                const data = [...m.data_points].reverse().map((p, i) => ({
                  idx: i + 1,
                  label: p.date ? new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : `#${i + 1}`,
                  output: p.output_per_hour,
                }))
                const trendColor = tone === 'critical' ? '#ef4444' : tone === 'good' ? '#10b981' : '#64748b'
                return (
                  <Card className={`shadow-sm border ${t.card}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <HardHat className="h-4 w-4 text-muted-foreground" />
                          <CardTitle className="text-sm font-semibold">Labor Productivity</CardTitle>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${t.badge}`}>
                          {m.trend.replace('_', ' ')}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {data.length > 0 ? (
                        <ChartContainer
                          config={{ output: { label: 'Output/hr', color: trendColor } }}
                          className="h-36 w-full"
                        >
                          <LineChart data={data} margin={{ left: 8, right: 12, top: 8, bottom: 4 }}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
                            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                            <Line type="monotone" dataKey="output" stroke={trendColor} strokeWidth={2} dot={{ r: 3 }} />
                          </LineChart>
                        </ChartContainer>
                      ) : (
                        <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">No labor data</div>
                      )}
                      <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                        Current <span className={`font-semibold ${t.valueText}`}>{m.current_output_per_hour.toFixed(1)}</span> output/hr
                        <TrendIcon className="h-3.5 w-3.5" />
                      </p>
                    </CardContent>
                  </Card>
                )
              })()}

              {/* Material Burn Rate — stacked bar: consumed vs remaining + runway comparison */}
              {(() => {
                const m = analytics.material_burn_rate
                const tone = statusTone(m.status)
                const t = toneStyles[tone]
                const allocated = Math.max(m.total_allocated, 1)
                const consumedPct = Math.min(100, (m.total_consumed / allocated) * 100)
                const data = [
                  {
                    name: 'Budget',
                    consumed: m.total_consumed,
                    remaining: Math.max(0, m.total_allocated - m.total_consumed),
                  },
                ]
                return (
                  <Card className={`shadow-sm border ${t.card}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-muted-foreground" />
                          <CardTitle className="text-sm font-semibold">Material Burn Rate</CardTitle>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${t.badge}`}>
                          {m.status.replace('_', ' ')}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <ChartContainer
                        config={{ consumed: { label: 'Consumed', color: '#f59e0b' }, remaining: { label: 'Remaining', color: '#e5e7eb' } }}
                        className="h-12 w-full"
                      >
                        <BarChart data={data} layout="vertical" margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
                          <XAxis type="number" hide />
                          <YAxis type="category" dataKey="name" hide />
                          <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                          <Bar dataKey="consumed" stackId="b" fill="#f59e0b" radius={[6, 0, 0, 6]} />
                          <Bar dataKey="remaining" stackId="b" fill="#e5e7eb" radius={[0, 6, 6, 0]} />
                        </BarChart>
                      </ChartContainer>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{formatBudget(m.total_consumed)} used ({consumedPct.toFixed(0)}%)</span>
                        <span>{formatBudget(m.total_allocated)} budget</span>
                      </div>

                      <div className="mt-1 space-y-1">
                        <p className="text-xs font-medium text-foreground">
                          {formatBudget(m.burn_rate_per_day)}<span className="font-normal text-muted-foreground">/day</span>
                        </p>
                        {m.days_until_exhaustion !== null && m.days_remaining_in_project > 0 && (() => {
                          const max = Math.max(m.days_until_exhaustion, m.days_remaining_in_project, 1)
                          const exhaustPct = (m.days_until_exhaustion / max) * 100
                          const projectPct = (m.days_remaining_in_project / max) * 100
                          const tight = m.days_until_exhaustion < m.days_remaining_in_project
                          return (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                                Budget runs out: {m.days_until_exhaustion}d
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                <div className="h-full rounded-full bg-amber-500" style={{ width: `${exhaustPct}%` }} />
                              </div>
                              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                                Project ends: {m.days_remaining_in_project}d
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${projectPct}%` }} />
                              </div>
                              {tight && (
                                <p className="text-[10px] font-medium text-red-600">
                                  Runs out {m.days_remaining_in_project - m.days_until_exhaustion}d before project ends
                                </p>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                    </CardContent>
                  </Card>
                )
              })()}
            </div>
          )}
        </div>
      )}

      {/* Weather Card */}
      {
        weather && (weather.temperature != null || weather.humidity != null || (weather.forecast && weather.forecast.length > 0)) && (
          <WeatherForecastCard weather={weather} projectLocation={project.location} />
        )
      }

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Recent Daily Logs</CardTitle>
            <CardDescription>Latest submission activity from site teams</CardDescription>
          </div>
          <Link href={`/dashboard/${projectId}/logs`}>
            <Button variant="ghost" size="sm" className="gap-1">
              View All Logs <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {visibleRecentLogs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No daily logs submitted yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Log</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Issue Flagged</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRecentLogs.map((log) => {
                  const issue = getIssueTag(log)
                  const taskName = log.task_id ? tasks.find(t => t.id === log.task_id)?.title : null

                  return (
                    <TableRow key={log.id}>
                      <TableCell>
                        <p className="font-medium">{taskName || `#${log.id.slice(0, 8).toUpperCase()}`}</p>
                        {log.notes && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{log.notes}</p>}
                      </TableCell>
                      <TableCell>{new Date(log.date).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <Badge className={
                          log.status === 'pm_approved' ? 'bg-emerald-100 text-emerald-700' :
                            log.status === 'consultant_approved' ? 'bg-indigo-100 text-indigo-700' :
                              log.status === 'submitted' ? 'bg-amber-100 text-amber-700' :
                                log.status === 'rejected' ? 'bg-red-100 text-red-700' :
                                  'bg-gray-100 text-gray-700'
                        }>
                          {log.status === 'pm_approved' ? 'Approved' : log.status.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={issue.className}>{issue.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/dashboard/${projectId}/logs/${log.id}`}>
                          <Button size="sm" className="h-8 px-4">
                            View
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {
        isProjectManager && pendingApprovals === 0 && (
          <Card className="border-emerald-200 bg-emerald-50">
            <CardContent className="flex items-center gap-3 p-4 text-emerald-800">
              <CheckCircle2 className="h-5 w-5" />
              <p className="text-sm font-medium">Approval queue is clear. All submitted logs are currently handled.</p>
            </CardContent>
          </Card>
        )
      }

      {
        isProjectManager && pendingApprovals > 0 && (
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="flex items-center gap-3 p-4 text-amber-800">
              <Clock3 className="h-5 w-5" />
              <p className="text-sm font-medium">
                {pendingApprovals} log(s) are waiting in the review/approval pipeline.
              </p>
            </CardContent>
          </Card>
        )
      }
    </div>
  )
}
