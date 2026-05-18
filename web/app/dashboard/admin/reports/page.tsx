'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/lib/auth-context'
import {
    getPlatformSummary, getActivitySummary,
    type PlatformSummary, type ActivitySeriesPoint,
} from '@/lib/api'
import { useCurrency } from '@/lib/currency-context'
import { Loader2, Users, Building2, ListTodo, ClipboardList } from 'lucide-react'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { CartesianGrid, Line, LineChart, XAxis, YAxis, Legend } from 'recharts'

export default function AdminReportsPage() {
    const router = useRouter()
    const { user, isAuthenticated, isLoading: authLoading } = useAuth()
    const { formatBudget } = useCurrency()
    const [summary, setSummary] = useState<PlatformSummary | null>(null)
    const [series, setSeries] = useState<ActivitySeriesPoint[]>([])
    const [days, setDays] = useState<number>(30)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!authLoading && !isAuthenticated) router.push('/login')
        if (!authLoading && isAuthenticated && !user?.is_admin) router.push('/dashboard')
    }, [authLoading, isAuthenticated, user, router])

    useEffect(() => {
        if (!isAuthenticated || !user?.is_admin) return
        let cancelled = false
        ;(async () => {
            setLoading(true)
            setError(null)
            try {
                const [s, a] = await Promise.all([
                    getPlatformSummary(),
                    getActivitySummary(days),
                ])
                if (cancelled) return
                setSummary(s)
                setSeries(a.series)
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load reports')
            } finally {
                if (!cancelled) setLoading(false)
            }
        })()
        return () => { cancelled = true }
    }, [isAuthenticated, user, days])

    if (authLoading || (loading && !summary)) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }
    if (!isAuthenticated || !user?.is_admin) return null

    return (
        <div className="p-8 space-y-6">
            <div className="flex items-end justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">System Reports</h1>
                    <p className="text-muted-foreground mt-1">Cross-project metrics and activity over time</p>
                </div>
                <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                    <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="7">Last 7 days</SelectItem>
                        <SelectItem value="30">Last 30 days</SelectItem>
                        <SelectItem value="90">Last 90 days</SelectItem>
                        <SelectItem value="180">Last 180 days</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {error && (
                <div className="p-4 border border-destructive/20 bg-destructive/5 rounded-lg text-sm text-destructive">
                    {error}
                </div>
            )}

            {summary && (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <SummaryCard
                        icon={<Users className="h-4 w-4 text-muted-foreground" />}
                        label="Users"
                        primary={`${summary.users.total}`}
                        sub={`${summary.users.active} active · ${summary.users.admins} admin`}
                    />
                    <SummaryCard
                        icon={<Building2 className="h-4 w-4 text-muted-foreground" />}
                        label="Projects"
                        primary={`${summary.projects.total}`}
                        sub={Object.entries(summary.projects.by_status)
                            .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' · ')}
                    />
                    <SummaryCard
                        icon={<ListTodo className="h-4 w-4 text-muted-foreground" />}
                        label="Tasks"
                        primary={`${summary.tasks.total}`}
                        sub={`${summary.tasks.completed} completed`}
                    />
                    <SummaryCard
                        icon={<ClipboardList className="h-4 w-4 text-muted-foreground" />}
                        label="Daily Logs"
                        primary={`${summary.daily_logs.total}`}
                        sub={`${summary.daily_logs.pm_approved} PM-approved`}
                    />
                </div>
            )}

            {summary && (
                <Card>
                    <CardHeader>
                        <CardTitle>Budget across all projects</CardTitle>
                        <CardDescription>Total contract value, spend, and remaining headroom</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="rounded-lg border bg-muted/30 p-4">
                                <p className="text-xs uppercase text-muted-foreground">Total Budget</p>
                                <p className="mt-1 text-2xl font-bold">{formatBudget(summary.projects.total_budget)}</p>
                            </div>
                            <div className="rounded-lg border bg-muted/30 p-4">
                                <p className="text-xs uppercase text-muted-foreground">Spent</p>
                                <p className="mt-1 text-2xl font-bold text-amber-700">{formatBudget(summary.projects.total_spent)}</p>
                            </div>
                            <div className="rounded-lg border bg-muted/30 p-4">
                                <p className="text-xs uppercase text-muted-foreground">Remaining</p>
                                <p className="mt-1 text-2xl font-bold text-emerald-700">{formatBudget(summary.projects.remaining)}</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>Activity over time</CardTitle>
                    <CardDescription>Signups, logins, log approvals, and audit events per day</CardDescription>
                </CardHeader>
                <CardContent>
                    <ChartContainer
                        config={{
                            signups: { label: 'Signups', color: '#10b981' },
                            logins: { label: 'Active Users', color: '#3b82f6' },
                            log_approvals: { label: 'Log Approvals', color: '#a855f7' },
                            audit_events: { label: 'Audit Events', color: '#f59e0b' },
                        }}
                        className="h-72 w-full"
                    >
                        <LineChart data={series} margin={{ left: 8, right: 12, top: 10 }}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                            <Legend />
                            <Line type="monotone" dataKey="signups" stroke="#10b981" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="logins" stroke="#3b82f6" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="log_approvals" stroke="#a855f7" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="audit_events" stroke="#f59e0b" strokeWidth={2} dot={false} />
                        </LineChart>
                    </ChartContainer>
                </CardContent>
            </Card>

        </div>
    )
}

function SummaryCard({ icon, label, primary, sub }: {
    icon: React.ReactNode; label: string; primary: string; sub: string;
}) {
    return (
        <Card>
            <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
                    {icon}
                </div>
                <p className="text-3xl font-bold">{primary}</p>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{sub}</p>
            </CardContent>
        </Card>
    )
}
