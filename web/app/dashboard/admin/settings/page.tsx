'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/lib/auth-context'
import { getSystemSettings, updateSystemSettings } from '@/lib/api'
import type { SystemSettingsStructured } from '@/lib/api-types'
import { Loader2, Save, Settings, ArrowLeft } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

export default function AdminSettingsPage() {
    const router = useRouter()
    const { user, isAuthenticated, isLoading: authLoading } = useAuth()
    const { toast } = useToast()
    const [settings, setSettings] = useState<SystemSettingsStructured | null>(null)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push('/login')
        }
        if (!authLoading && isAuthenticated && !user?.is_admin) {
            router.push('/dashboard')
        }
    }, [authLoading, isAuthenticated, user, router])

    useEffect(() => {
        if (!isAuthenticated || !user?.is_admin) return

        let cancelled = false

            ; (async () => {
                setLoading(true)
                setError(null)
                try {
                    const data = await getSystemSettings()
                    if (!cancelled) {
                        setSettings(data)
                    }
                } catch (err) {
                    if (!cancelled) {
                        setError(err instanceof Error ? err.message : 'Failed to load settings')
                    }
                } finally {
                    if (!cancelled) {
                        setLoading(false)
                    }
                }
            })()

        return () => {
            cancelled = true
        }
    }, [isAuthenticated, user])

    const handleSave = async () => {
        if (!settings) return

        setSaving(true)
        try {
            const updated = await updateSystemSettings(settings)
            setSettings(updated)
            toast({
                title: 'Success',
                description: 'System settings updated successfully',
            })
        } catch (err) {
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to update settings',
                variant: 'destructive',
            })
        } finally {
            setSaving(false)
        }
    }

    if (authLoading || loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }

    if (!isAuthenticated || !user?.is_admin) return null

    if (error) {
        return (
            <div className="p-8">
                <Card className="border-destructive/20 bg-destructive/5">
                    <CardContent className="p-6 text-sm text-destructive">{error}</CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="p-8 space-y-8">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">System Settings</h1>
                <p className="text-muted-foreground mt-2">Configure platform-wide settings and preferences</p>
            </div>

            <div className="grid gap-6 max-w-4xl">
                {/* Working Hours Configuration */}
                <Card>
                    <CardHeader>
                        <CardTitle>Working Hours Configuration</CardTitle>
                        <CardDescription>
                            Configure standard working hours and days for labor cost calculations
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="working_hours_per_day">Working Hours Per Day</Label>
                                <Input
                                    id="working_hours_per_day"
                                    type="number"
                                    step="0.5"
                                    min="1"
                                    max="24"
                                    value={settings?.working_hours_per_day ?? 8}
                                    onChange={(e) =>
                                        setSettings((prev) =>
                                            prev ? { ...prev, working_hours_per_day: parseFloat(e.target.value) } : null
                                        )
                                    }
                                />
                                <p className="text-xs text-muted-foreground">
                                    Standard hours per shift (used for labor cost calculations)
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="working_days_per_week">Working Days Per Week</Label>
                                <Input
                                    id="working_days_per_week"
                                    type="number"
                                    min="1"
                                    max="7"
                                    value={settings?.working_days_per_week ?? 6}
                                    onChange={(e) =>
                                        setSettings((prev) =>
                                            prev ? { ...prev, working_days_per_week: parseInt(e.target.value) } : null
                                        )
                                    }
                                />
                                <p className="text-xs text-muted-foreground">
                                    Typical working days per week (Ethiopian construction: 6)
                                </p>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="overtime_multiplier">Overtime Multiplier</Label>
                            <Input
                                id="overtime_multiplier"
                                type="number"
                                step="0.1"
                                min="1"
                                max="3"
                                value={settings?.overtime_multiplier ?? 1.5}
                                onChange={(e) =>
                                    setSettings((prev) =>
                                        prev ? { ...prev, overtime_multiplier: parseFloat(e.target.value) } : null
                                    )
                                }
                            />
                            <p className="text-xs text-muted-foreground">
                                Overtime cost = hourly_rate × overtime_multiplier (default: 1.5x)
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* Alert Thresholds */}
                <Card>
                    <CardHeader>
                        <CardTitle>Alert Thresholds</CardTitle>
                        <CardDescription>
                            Configure automatic alerts for project delays and budget overruns
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="delay_risk_threshold_pct">Delay Risk Threshold (%)</Label>
                            <Input
                                id="delay_risk_threshold_pct"
                                type="number"
                                min="0"
                                max="100"
                                value={settings?.delay_risk_threshold_pct ?? 60}
                                onChange={(e) =>
                                    setSettings((prev) =>
                                        prev ? { ...prev, delay_risk_threshold_pct: parseFloat(e.target.value) } : null
                                    )
                                }
                            />
                            <p className="text-xs text-muted-foreground">
                                When ML risk score exceeds this %, project status changes to "at_risk" and PM receives
                                alert (default: 60%)
                            </p>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="budget_alert_threshold_pct">Budget Alert Threshold (%)</Label>
                            <Input
                                id="budget_alert_threshold_pct"
                                type="number"
                                min="0"
                                max="100"
                                value={settings?.budget_alert_threshold_pct ?? 80}
                                onChange={(e) =>
                                    setSettings((prev) =>
                                        prev ? { ...prev, budget_alert_threshold_pct: parseFloat(e.target.value) } : null
                                    )
                                }
                            />
                            <p className="text-xs text-muted-foreground">
                                When total_spent / contract_value crosses this %, PM receives budget alert (default: 80%)
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* Maintenance Mode */}
                <Card>
                    <CardHeader>
                        <CardTitle>Maintenance Mode</CardTitle>
                        <CardDescription>
                            Block all non-admin logins for deployments, migrations, or system maintenance
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <Label htmlFor="maintenance_mode">Enable Maintenance Mode</Label>
                                <p className="text-sm text-muted-foreground">
                                    When enabled, only admins can access the system
                                </p>
                            </div>
                            <Switch
                                id="maintenance_mode"
                                checked={settings?.maintenance_mode ?? false}
                                onCheckedChange={(checked) =>
                                    setSettings((prev) => (prev ? { ...prev, maintenance_mode: checked } : null))
                                }
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Save Button */}
                <div className="flex justify-end">
                    <Button onClick={handleSave} disabled={saving} className="gap-2">
                        {saving ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            <>
                                <Save className="h-4 w-4" />
                                Save Settings
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </div>
    )
}
