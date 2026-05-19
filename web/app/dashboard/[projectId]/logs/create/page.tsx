'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { ArrowLeft, Loader2, Plus, Trash2, Upload, X } from 'lucide-react'
import { createDailyLog, listProjectTasks, listTaskActivities, addLogManpower, addLogMaterial, addLogEquipment, addLogCompletedActivity, getWeather, listSuppliers } from '@/lib/api'
import { getApiBaseUrl } from '@/lib/api-client'
import { getAccessToken } from '@/lib/auth-storage'
import type { TaskListItem, TaskActivityItem, SupplierItem } from '@/lib/api-types'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import { useLanguage } from '@/lib/language-context'

interface CreateLogPageProps {
    params: Promise<{ projectId: string }>
}

type HumanResourceEntry = {
    labor_type: string
    worker_count: string
    hours_worked: string
    hourly_rate: string
    overtime_hours: string
    overtime_rate: string
}
type MaterialEntry = {
    supplier_id: string
    material_type: string
    quantity: string
    unit: string
    unit_cost: string
    delivery_date: string
}
type EquipmentEntry = {
    type: string
    quantity: string
    start_time: string
    operation_time: string
    cost_per_unit: string
    idle_hours: string
    idle_reason: string
}

export default function CreateLogPage({ params }: CreateLogPageProps) {
    const { projectId } = use(params)
    const router = useRouter()
    const { user } = useAuth()
    const { t } = useLanguage()

    const [tasks, setTasks] = useState<TaskListItem[]>([])
    const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
    const [allActivities, setAllActivities] = useState<Map<string, TaskActivityItem[]>>(new Map())
    const [selectedActivities, setSelectedActivities] = useState<Set<string>>(new Set())
    const [notes, setNotes] = useState('')
    const [photos, setPhotos] = useState<File[]>([])
    const [suppliers, setSuppliers] = useState<SupplierItem[]>([])

    // Human Resource entries
    const [humanResources, setHumanResources] = useState<HumanResourceEntry[]>([{
        labor_type: '',
        worker_count: '1',
        hours_worked: '8',
        hourly_rate: '',
        overtime_hours: '0',
        overtime_rate: ''
    }])

    // Material entries
    const [materials, setMaterials] = useState<MaterialEntry[]>([{
        supplier_id: '',
        material_type: '',
        quantity: '',
        unit: 'bags',
        unit_cost: '',
        delivery_date: new Date().toISOString().split('T')[0]
    }])

    // Equipment entries
    const [equipment, setEquipment] = useState<EquipmentEntry[]>([{
        type: '',
        quantity: '1',
        start_time: '08:00',
        operation_time: '',
        cost_per_unit: '',
        idle_hours: '0',
        idle_reason: ''
    }])

    const [loading, setLoading] = useState(true)
    const [creating, setCreating] = useState(false)

    useEffect(() => {
        const loadTasks = async () => {
            setLoading(true)
            try {
                const res = await listProjectTasks(projectId, {
                    limit: 100,
                    assigned_to: user?.id,
                })

                const taskRows = res.data.filter(t => t.status !== 'completed')
                const taskIdsWithActivities = new Set<string>()

                await Promise.all(taskRows.map(async (task) => {
                    try {
                        const activities = await listTaskActivities(task.id)
                        if (activities.some(a => !a.is_completed)) {
                            taskIdsWithActivities.add(task.id)
                        }
                    } catch {
                        // ignore activity load errors for filtering
                    }
                }))

                setTasks(taskRows.filter(task => taskIdsWithActivities.has(task.id)))

                // Load suppliers for this project
                const suppliersData = await listSuppliers(projectId, { limit: 100 })
                setSuppliers(suppliersData)
            } catch {
                setTasks([])
                setSuppliers([])
            } finally {
                setLoading(false)
            }
        }
        loadTasks()
    }, [projectId, user?.id])

    // Load activities for selected tasks (only incomplete activities)
    useEffect(() => {
        const loadActivities = async () => {
            const activitiesMap = new Map<string, TaskActivityItem[]>()

            for (const taskId of selectedTaskIds) {
                try {
                    const activities = await listTaskActivities(taskId)
                    // Only show incomplete activities
                    const incompleteActivities = activities.filter(a => !a.is_completed)
                    activitiesMap.set(taskId, incompleteActivities)
                } catch {
                    activitiesMap.set(taskId, [])
                }
            }

            setAllActivities(activitiesMap)
        }

        if (selectedTaskIds.size > 0) {
            loadActivities()
        } else {
            setAllActivities(new Map())
            setSelectedActivities(new Set())
        }
    }, [selectedTaskIds])

    const calculateHumanResourceTotal = (entry: HumanResourceEntry) => {
        const workerCount = Number(entry.worker_count) || 0
        const hoursWorked = Number(entry.hours_worked) || 0
        const hourlyRate = Number(entry.hourly_rate) || 0
        const overtimeHours = Number(entry.overtime_hours) || 0
        const overtimeRate = Number(entry.overtime_rate) || (hourlyRate * 1.5) // Default 1.5x if not set

        const regularCost = workerCount * hoursWorked * hourlyRate
        const overtimeCost = workerCount * overtimeHours * overtimeRate
        return regularCost + overtimeCost
    }

    const calculateMaterialTotal = (entry: MaterialEntry) => {
        const quantity = Number(entry.quantity) || 0
        const unitCost = Number(entry.unit_cost) || 0
        return quantity * unitCost
    }

    const calculateEquipmentTotal = (entry: EquipmentEntry) => {
        const operationTime = Number(entry.operation_time) || 0
        const costPerUnit = Number(entry.cost_per_unit) || 0
        return operationTime * costPerUnit
    }

    const totalHumanResourceCost = humanResources.reduce((sum, entry) => sum + calculateHumanResourceTotal(entry), 0)
    const totalMaterialCost = materials.reduce((sum, entry) => sum + calculateMaterialTotal(entry), 0)
    const totalEquipmentCost = equipment.reduce((sum, entry) => sum + calculateEquipmentTotal(entry), 0)
    const grandTotal = totalHumanResourceCost + totalMaterialCost + totalEquipmentCost

    const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || [])
        const validFiles: File[] = []

        // Validate: max 5 files
        if (photos.length + files.length > 5) {
            toast.error(t('dailyLogPage.maxPhotosErr'))
            return
        }

        for (const file of files) {
            // Validate file type and size
            const MAX_SIZE = 10 * 1024 * 1024 // 10MB
            const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

            if (!ALLOWED_TYPES.includes(file.type)) {
                toast.error(t('dailyLogPage.invalidPhotoType').replace('{name}', file.name))
                continue
            }

            if (file.size > MAX_SIZE) {
                toast.error(t('dailyLogPage.photoTooLarge').replace('{name}', file.name))
                continue
            }

            validFiles.push(file)
        }

        setPhotos(prev => [...prev, ...validFiles])
    }

    const handleClear = () => {
        if (!confirm(t('dailyLogPage.clearConfirm'))) {
            return
        }

        // Reset all form fields
        setSelectedTaskIds(new Set())
        setAllActivities(new Map())
        setSelectedActivities(new Set())
        setNotes('')
        setPhotos([])

        // Reset human resources to initial state
        setHumanResources([{
            labor_type: '',
            worker_count: '1',
            hours_worked: '8',
            hourly_rate: '',
            overtime_hours: '0',
            overtime_rate: ''
        }])

        // Reset materials to initial state
        setMaterials([{
            supplier_id: '',
            material_type: '',
            quantity: '',
            unit: 'bags',
            unit_cost: '',
            delivery_date: new Date().toISOString().split('T')[0]
        }])

        // Reset equipment to initial state
        setEquipment([{
            type: '',
            quantity: '1',
            start_time: '08:00',
            operation_time: '',
            cost_per_unit: '',
            idle_hours: '0',
            idle_reason: ''
        }])

        toast.success(t('dailyLogPage.fieldsCleared'))
    }

    const handleCreate = async (saveAsDraft: boolean = false) => {
        if (selectedTaskIds.size === 0) {
            toast.error(t('dailyLogPage.selectTaskErr'))
            return
        }

        if (!saveAsDraft && selectedActivities.size === 0) {
            toast.error(t('dailyLogPage.selectActivityErr'))
            return
        }

        // Validate at least one entry
        const hasHumanResource = humanResources.some(h => h.labor_type.trim() && h.worker_count && h.hours_worked && h.hourly_rate)
        const hasMaterial = materials.some(m => m.material_type.trim() && m.quantity && m.unit_cost)
        const hasEquipment = equipment.some(e => e.type.trim() && e.operation_time && e.cost_per_unit)


        setCreating(true)
        try {
            // Get weather
            let weatherStr: string | undefined
            try {
                const w = await getWeather(projectId)
                if (w?.temperature != null) {
                    weatherStr = `${w.temperature.toFixed(0)}°C, ${w.humidity?.toFixed(0) ?? ''}% humidity`
                    if (w.resolved_location) weatherStr += ` (${w.resolved_location})`
                }
            } catch { /* weather is optional */ }

            // Create log without a specific task (task_id will be null)
            // We'll use the first selected task for the API call, but the log covers multiple tasks
            const firstTaskId = Array.from(selectedTaskIds)[0]
            const created = await createDailyLog(projectId, firstTaskId, {
                notes: notes.trim() || undefined,
                weather: weatherStr,
            })

            const logId = (created as any).id
            if (!logId) {
                throw new Error('Failed to get log ID')
            }

            // Add human resources
            for (const entry of humanResources) {
                if (entry.labor_type.trim() && entry.worker_count && entry.hours_worked && entry.hourly_rate) {
                    const total = calculateHumanResourceTotal(entry)
                    const workerCount = Number(entry.worker_count)
                    const hoursWorked = Number(entry.hours_worked)
                    const overtimeHours = Number(entry.overtime_hours) || 0
                    const hourlyRate = Number(entry.hourly_rate)
                    const overtimeRate = Number(entry.overtime_rate) || (hourlyRate * 1.5)

                    await addLogManpower(logId, {
                        worker_type: entry.labor_type.trim(),
                        number_of_workers: workerCount,
                        hours_worked: hoursWorked,
                        overtime_hours: overtimeHours,
                        hourly_rate: hourlyRate,
                        overtime_rate: overtimeRate,
                        cost: total,
                    })
                }
            }

            // Add materials
            for (const entry of materials) {
                if (entry.material_type.trim() && entry.quantity && entry.unit_cost) {
                    const total = calculateMaterialTotal(entry)
                    const supplierObj = entry.supplier_id ? suppliers.find(s => s.id === entry.supplier_id) : null
                    const unitCost = Number(entry.unit_cost)
                    await addLogMaterial(logId, {
                        name: entry.material_type.trim(),
                        supplier_id: entry.supplier_id || undefined,
                        supplier_name: supplierObj?.name || undefined,
                        quantity: Number(entry.quantity),
                        unit: entry.unit,
                        unit_cost: unitCost,
                        cost: total,
                        delivery_date: entry.delivery_date || undefined,
                    })
                }
            }

            // Add equipment
            for (const entry of equipment) {
                if (entry.type.trim() && entry.operation_time && entry.cost_per_unit) {
                    const total = calculateEquipmentTotal(entry)
                    const unitCost = Number(entry.cost_per_unit)
                    const startDate = entry.start_time ? `${new Date().toISOString().split('T')[0]}T${entry.start_time}:00Z` : undefined
                    await addLogEquipment(logId, {
                        name: entry.type.trim(),
                        quantity: Number(entry.quantity) || 1,
                        start_date: startDate,
                        hours_used: Number(entry.operation_time),
                        unit_cost: unitCost,
                        cost: total,
                        idle_hours: Number(entry.idle_hours) || 0,
                        idle_reason: entry.idle_reason.trim() || undefined,
                    })
                }
            }

            // Mark activities complete from all selected tasks (only if not draft)
            if (!saveAsDraft) {
                for (const activityId of selectedActivities) {
                    try {
                        await addLogCompletedActivity(logId, activityId)
                    } catch (e) {
                        console.error('Failed to mark activity complete:', e)
                    }
                }
            }

            // Upload photos using backend endpoint
            for (const photo of photos) {
                try {
                    const formData = new FormData()
                    formData.append('file', photo)

                    await fetch(`${getApiBaseUrl()}/daily-logs/${logId}/photos`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${getAccessToken() ?? ''}`,
                        },
                        body: formData,
                    })
                } catch (e) {
                    console.error('Failed to upload photo:', e)
                    toast.error(t('dailyLogPage.photoUploadErr').replace('{name}', photo.name))
                }
            }

            toast.success(saveAsDraft ? t('dailyLogPage.draftSuccess') : t('dailyLogPage.createSuccess'))
            router.push(`/dashboard/${projectId}/logs/${logId}`)
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('dailyLogPage.failedToCreate'))
        } finally {
            setCreating(false)
        }
    }

    if (loading) {
        return (
            <div className="flex justify-center py-24">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-6 pb-12">
            <div className="flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => router.back()}>
                    <ArrowLeft className="h-5 w-5" />
                </Button>
                <div>
                    <h1 className="text-2xl font-bold">{t('dailyLogPage.title')}</h1>
                    <p className="text-sm text-muted-foreground">{t('dailyLogPage.subtitle')}</p>
                </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
                <div className="space-y-6">
                    {/* Task Selection */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">{t('dailyLogPage.tasksWorked')}</CardTitle>
                            <p className="text-sm text-muted-foreground">{t('dailyLogPage.tasksWorkedDesc')}</p>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {tasks.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{t('dailyLogPage.noAssignedTasks')}</p>
                            ) : (
                                <div className="space-y-2 max-h-64 overflow-y-auto rounded-lg border p-3">
                                    {tasks.map((task) => (
                                        <label key={task.id} className="flex items-center gap-3 cursor-pointer p-2 rounded hover:bg-muted/50">
                                            <input
                                                type="checkbox"
                                                checked={selectedTaskIds.has(task.id)}
                                                onChange={(e) => {
                                                    const updated = new Set(selectedTaskIds)
                                                    if (e.target.checked) {
                                                        updated.add(task.id)
                                                    } else {
                                                        updated.delete(task.id)
                                                        // Remove activities from this task
                                                        const taskActivities = allActivities.get(task.id) || []
                                                        const updatedActivities = new Set(selectedActivities)
                                                        taskActivities.forEach(a => updatedActivities.delete(a.id))
                                                        setSelectedActivities(updatedActivities)
                                                    }
                                                    setSelectedTaskIds(updated)
                                                }}
                                                className="h-4 w-4 rounded border-gray-300"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium truncate">{task.title}</p>
                                                <p className="text-xs text-muted-foreground">{task.status.replace('_', ' ')} • {task.progress_percentage}% complete</p>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            )}

                            {selectedTaskIds.size > 0 && Array.from(allActivities.entries()).some(([_, activities]) => activities.length > 0) && (
                                <div className="space-y-2">
                                    <Label>{t('dailyLogPage.activitiesCompleted')}</Label>
                                    <p className="text-xs text-muted-foreground">{t('dailyLogPage.activitiesCompletedDesc')}</p>
                                    <div className="space-y-3 max-h-64 overflow-y-auto rounded-lg border p-3">
                                        {Array.from(allActivities.entries()).map(([taskId, activities]) => {
                                            if (!selectedTaskIds.has(taskId) || activities.length === 0) return null
                                            const task = tasks.find(t => t.id === taskId)
                                            return (
                                                <div key={taskId} className="space-y-2">
                                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                                        {task?.title}
                                                    </p>
                                                    {activities.map((activity) => (
                                                        <label key={activity.id} className="flex items-center gap-3 cursor-pointer pl-2">
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedActivities.has(activity.id)}
                                                                onChange={(e) => {
                                                                    const updated = new Set(selectedActivities)
                                                                    if (e.target.checked) {
                                                                        updated.add(activity.id)
                                                                    } else {
                                                                        updated.delete(activity.id)
                                                                    }
                                                                    setSelectedActivities(updated)
                                                                }}
                                                                className="h-4 w-4 rounded border-gray-300"
                                                            />
                                                            <span className="text-sm flex-1">{activity.name}</span>
                                                            <span className="text-xs text-muted-foreground">{activity.percentage}%</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* Human Resources */}
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle className="text-base">{t('dailyLogPage.humanResources')}</CardTitle>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1"
                                onClick={() => setHumanResources([...humanResources, {
                                    labor_type: '',
                                    worker_count: '1',
                                    hours_worked: '8',
                                    hourly_rate: '',
                                    overtime_hours: '0',
                                    overtime_rate: ''
                                }])}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                {t('dailyLogPage.add')}
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {humanResources.map((entry, index) => (
                                <div key={index} className="space-y-2 rounded-lg border p-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-medium">
                                            {t('dailyLogPage.entry').replace('{index}', String(index + 1))}
                                        </span>
                                        {humanResources.length > 1 && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7"
                                                onClick={() => setHumanResources(humanResources.filter((_, i) => i !== index))}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                    <div className="grid gap-2">
                                        <Input
                                            placeholder={t('dailyLogPage.laborType')}
                                            value={entry.labor_type}
                                            onChange={(e) => {
                                                const updated = [...humanResources]
                                                updated[index].labor_type = e.target.value
                                                setHumanResources(updated)
                                            }}
                                        />
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.workerCount')}</Label>
                                                <Input
                                                    type="number"
                                                    min="1"
                                                    placeholder={t('dailyLogPage.workers')}
                                                    value={entry.worker_count}
                                                    onChange={(e) => {
                                                        const updated = [...humanResources]
                                                        updated[index].worker_count = e.target.value
                                                        setHumanResources(updated)
                                                    }}
                                                />
                                            </div>
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.hourlyRate')}</Label>
                                                <Input
                                                    type="number"
                                                    step="0.01"
                                                    placeholder={t('dailyLogPage.rateHr')}
                                                    value={entry.hourly_rate}
                                                    onChange={(e) => {
                                                        const updated = [...humanResources]
                                                        updated[index].hourly_rate = e.target.value
                                                        setHumanResources(updated)
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.regularHours')}</Label>
                                                <Input
                                                    type="number"
                                                    step="0.5"
                                                    placeholder={t('dailyLogPage.hours')}
                                                    value={entry.hours_worked}
                                                    onChange={(e) => {
                                                        const updated = [...humanResources]
                                                        updated[index].hours_worked = e.target.value
                                                        setHumanResources(updated)
                                                    }}
                                                />
                                            </div>
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.overtimeHours')}</Label>
                                                <Input
                                                    type="number"
                                                    step="0.5"
                                                    placeholder={t('dailyLogPage.otHours')}
                                                    value={entry.overtime_hours}
                                                    onChange={(e) => {
                                                        const updated = [...humanResources]
                                                        updated[index].overtime_hours = e.target.value
                                                        setHumanResources(updated)
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <Label className="text-xs text-muted-foreground">{t('dailyLogPage.overtimeRate')}</Label>
                                            <Input
                                                type="number"
                                                step="0.01"
                                                placeholder={t('dailyLogPage.otRateOpt')}
                                                value={entry.overtime_rate}
                                                onChange={(e) => {
                                                    const updated = [...humanResources]
                                                    updated[index].overtime_rate = e.target.value
                                                    setHumanResources(updated)
                                                }}
                                            />
                                        </div>
                                        <div className="text-right text-sm font-medium pt-2 border-t">
                                            {t('dailyLogPage.total').replace('{amount}', calculateHumanResourceTotal(entry).toLocaleString())}
                                        </div>
                                    </div>
                                </div>
                            ))}
                            <div className="text-right text-base font-semibold pt-2 border-t">
                                {t('dailyLogPage.hrTotal').replace('{amount}', totalHumanResourceCost.toLocaleString())}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Materials */}
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle className="text-base">{t('dailyLogPage.materials')}</CardTitle>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1"
                                onClick={() => setMaterials([...materials, {
                                    supplier_id: '',
                                    material_type: '',
                                    quantity: '',
                                    unit: 'bags',
                                    unit_cost: '',
                                    delivery_date: new Date().toISOString().split('T')[0]
                                }])}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                {t('dailyLogPage.add')}
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {materials.map((entry, index) => (
                                <div key={index} className="space-y-2 rounded-lg border p-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-medium">
                                            {t('dailyLogPage.entry').replace('{index}', String(index + 1))}
                                        </span>
                                        {materials.length > 1 && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7"
                                                onClick={() => setMaterials(materials.filter((_, i) => i !== index))}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                    <div className="grid gap-2">
                                        <div>
                                            <Label className="text-xs text-muted-foreground">{t('dailyLogPage.supplier')}</Label>
                                            <Select
                                                value={entry.supplier_id || 'none'}
                                                onValueChange={(value) => {
                                                    const updated = [...materials]
                                                    updated[index].supplier_id = value === 'none' ? '' : value
                                                    setMaterials(updated)
                                                }}
                                            >
                                                <SelectTrigger>
                                                    <SelectValue placeholder={t('dailyLogPage.selectSupplier')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">{t('dailyLogPage.noSupplier')}</SelectItem>
                                                    {suppliers.map((s) => (
                                                        <SelectItem key={s.id} value={s.id}>
                                                            {s.name} {s.role ? `(${s.role})` : ''}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <Input
                                            placeholder={t('dailyLogPage.materialType')}
                                            value={entry.material_type}
                                            onChange={(e) => {
                                                const updated = [...materials]
                                                updated[index].material_type = e.target.value
                                                setMaterials(updated)
                                            }}
                                        />
                                        <div className="grid grid-cols-3 gap-2">
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.quantity')}</Label>
                                                <Input
                                                    type="number"
                                                    step="0.001"
                                                    placeholder={t('dailyLogPage.qty')}
                                                    value={entry.quantity}
                                                    onChange={(e) => {
                                                        const updated = [...materials]
                                                        updated[index].quantity = e.target.value
                                                        setMaterials(updated)
                                                    }}
                                                />
                                            </div>
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.unit')}</Label>
                                                <select
                                                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                                    value={entry.unit}
                                                    onChange={(e) => {
                                                        const updated = [...materials]
                                                        updated[index].unit = e.target.value
                                                        setMaterials(updated)
                                                    }}
                                                >
                                                    <option value="bags">bags</option>
                                                    <option value="kg">kg</option>
                                                    <option value="m3">m³</option>
                                                    <option value="m2">m²</option>
                                                    <option value="pieces">pieces</option>
                                                    <option value="tons">tons</option>
                                                    <option value="liters">liters</option>
                                                </select>
                                            </div>
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.unitCost')}</Label>
                                                <Input
                                                    type="number"
                                                    step="0.01"
                                                    placeholder={t('dailyLogPage.cost')}
                                                    value={entry.unit_cost}
                                                    onChange={(e) => {
                                                        const updated = [...materials]
                                                        updated[index].unit_cost = e.target.value
                                                        setMaterials(updated)
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <Label className="text-xs text-muted-foreground">{t('dailyLogPage.deliveryDate')}</Label>
                                            <Input
                                                type="date"
                                                value={entry.delivery_date}
                                                onChange={(e) => {
                                                    const updated = [...materials]
                                                    updated[index].delivery_date = e.target.value
                                                    setMaterials(updated)
                                                }}
                                            />
                                        </div>
                                        <div className="text-right text-sm font-medium pt-2 border-t">
                                            {t('dailyLogPage.total').replace('{amount}', calculateMaterialTotal(entry).toLocaleString())}
                                        </div>
                                    </div>
                                </div>
                            ))}
                            <div className="text-right text-base font-semibold pt-2 border-t">
                                {t('dailyLogPage.materialsTotal').replace('{amount}', totalMaterialCost.toLocaleString())}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Equipment */}
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle className="text-base">{t('dailyLogPage.equipment')}</CardTitle>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1"
                                onClick={() => setEquipment([...equipment, {
                                    type: '',
                                    quantity: '1',
                                    start_time: '08:00',
                                    operation_time: '',
                                    cost_per_unit: '',
                                    idle_hours: '0',
                                    idle_reason: ''
                                }])}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                {t('dailyLogPage.add')}
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {equipment.map((entry, index) => (
                                <div key={index} className="space-y-2 rounded-lg border p-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-medium">
                                            {t('dailyLogPage.entry').replace('{index}', String(index + 1))}
                                        </span>
                                        {equipment.length > 1 && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7"
                                                onClick={() => setEquipment(equipment.filter((_, i) => i !== index))}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                    <div className="grid gap-2">
                                        <Input
                                            placeholder={t('dailyLogPage.equipmentType')}
                                            value={entry.type}
                                            onChange={(e) => {
                                                const updated = [...equipment]
                                                updated[index].type = e.target.value
                                                setEquipment(updated)
                                            }}
                                        />
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.quantity')}</Label>
                                                <Input
                                                    type="number"
                                                    min="1"
                                                    placeholder={t('dailyLogPage.qty')}
                                                    value={entry.quantity}
                                                    onChange={(e) => {
                                                        const updated = [...equipment]
                                                        updated[index].quantity = e.target.value
                                                        setEquipment(updated)
                                                    }}
                                                />
                                            </div>
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.startTime')}</Label>
                                                <Input
                                                    type="time"
                                                    value={entry.start_time}
                                                    onChange={(e) => {
                                                        const updated = [...equipment]
                                                        updated[index].start_time = e.target.value
                                                        setEquipment(updated)
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.operationTime')}</Label>
                                                <Input
                                                    type="number"
                                                    step="0.5"
                                                    placeholder={t('dailyLogPage.hoursTrips')}
                                                    value={entry.operation_time}
                                                    onChange={(e) => {
                                                        const updated = [...equipment]
                                                        updated[index].operation_time = e.target.value
                                                        setEquipment(updated)
                                                    }}
                                                />
                                            </div>
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.costUnit')}</Label>
                                                <Input
                                                    type="number"
                                                    step="0.01"
                                                    placeholder={t('dailyLogPage.costHrTrip')}
                                                    value={entry.cost_per_unit}
                                                    onChange={(e) => {
                                                        const updated = [...equipment]
                                                        updated[index].cost_per_unit = e.target.value
                                                        setEquipment(updated)
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.idleHours')}</Label>
                                                <Input
                                                    type="number"
                                                    step="0.5"
                                                    placeholder={t('dailyLogPage.idleHoursPlaceholder')}
                                                    value={entry.idle_hours}
                                                    onChange={(e) => {
                                                        const updated = [...equipment]
                                                        updated[index].idle_hours = e.target.value
                                                        setEquipment(updated)
                                                    }}
                                                />
                                            </div>
                                            <div>
                                                <Label className="text-xs text-muted-foreground">{t('dailyLogPage.idleReason')}</Label>
                                                <Input
                                                    placeholder={t('dailyLogPage.idleReasonPlaceholder')}
                                                    value={entry.idle_reason}
                                                    onChange={(e) => {
                                                        const updated = [...equipment]
                                                        updated[index].idle_reason = e.target.value
                                                        setEquipment(updated)
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        <div className="text-right text-sm font-medium pt-2 border-t">
                                            {t('dailyLogPage.total').replace('{amount}', calculateEquipmentTotal(entry).toLocaleString())}
                                        </div>
                                    </div>
                                </div>
                            ))}
                            <div className="text-right text-base font-semibold pt-2 border-t">
                                {t('dailyLogPage.equipmentTotal').replace('{amount}', totalEquipmentCost.toLocaleString())}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Remarks and Photos - Moved to bottom */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">{t('dailyLogPage.remarksPhotos')}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>{t('dailyLogPage.remarks')}</Label>
                                <Textarea
                                    placeholder={t('dailyLogPage.remarksPlaceholder')}
                                    value={notes}
                                    onChange={(e) => setNotes(e.target.value)}
                                    rows={3}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>{t('dailyLogPage.photos')}</Label>
                                <div className="space-y-2">
                                    <input
                                        type="file"
                                        accept="image/*"
                                        multiple
                                        onChange={handlePhotoSelect}
                                        className="hidden"
                                        id="photo-upload"
                                    />
                                    <label htmlFor="photo-upload">
                                        <Button type="button" variant="outline" className="w-full gap-2" asChild>
                                            <span>
                                                <Upload className="h-4 w-4" />
                                                {t('dailyLogPage.uploadPhotos')}
                                            </span>
                                        </Button>
                                    </label>
                                    {photos.length > 0 && (
                                        <div className="grid grid-cols-3 gap-2">
                                            {photos.map((photo, index) => (
                                                <div key={index} className="relative group">
                                                    <img
                                                        src={URL.createObjectURL(photo)}
                                                        alt={photo.name}
                                                        className="w-full h-24 object-cover rounded-lg border"
                                                    />
                                                    <Button
                                                        type="button"
                                                        variant="destructive"
                                                        size="icon"
                                                        className="absolute top-1 right-1 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                                        onClick={() => setPhotos(photos.filter((_, i) => i !== index))}
                                                    >
                                                        <X className="h-3 w-3" />
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Summary Sidebar */}
                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">{t('dailyLogPage.summary')}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">{t('dailyLogPage.humanResources')}</span>
                                    <span className="font-medium">ETB {totalHumanResourceCost.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">{t('dailyLogPage.materials')}</span>
                                    <span className="font-medium">ETB {totalMaterialCost.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">{t('dailyLogPage.equipment')}</span>
                                    <span className="font-medium">ETB {totalEquipmentCost.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between pt-2 border-t text-base">
                                    <span className="font-semibold">{t('dailyLogPage.grandTotal')}</span>
                                    <span className="font-bold">ETB {grandTotal.toLocaleString()}</span>
                                </div>
                            </div>

                            <div className="space-y-2 pt-2 border-t text-sm">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">
                                        {t('dailyLogPage.tasksCount').split('(')[0].trim()}
                                    </span>
                                    <span className="font-medium">
                                        {t('dailyLogPage.tasksCount')
                                            .replace('Tasks', '')
                                            .replace('ስራዎች', '')
                                            .replace('{count}', String(selectedTaskIds.size))
                                            .replace('(', '')
                                            .replace(')', '')
                                            .trim()}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">
                                        {t('dailyLogPage.activitiesCount').split('(')[0].trim()}
                                    </span>
                                    <span className="font-medium">
                                        {t('dailyLogPage.activitiesCount')
                                            .replace('Activities', '')
                                            .replace('ክንዋኔዎች', '')
                                            .replace('{count}', String(selectedActivities.size))
                                            .replace('(', '')
                                            .replace(')', '')
                                            .trim()}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">
                                        {t('dailyLogPage.photosCount').split('(')[0].trim()}
                                    </span>
                                    <span className="font-medium">
                                        {t('dailyLogPage.photosCount')
                                            .replace('Photos', '')
                                            .replace('ፎቶዎች', '')
                                            .replace('{count}', String(photos.length))
                                            .replace('(', '')
                                            .replace(')', '')
                                            .trim()}
                                    </span>
                                </div>
                            </div>

                            <Button
                                className="w-full"
                                onClick={() => handleCreate(false)}
                                disabled={creating || selectedTaskIds.size === 0 || selectedActivities.size === 0}
                            >
                                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                {t('dailyLogPage.saveDraft')}
                            </Button>

                            <Button
                                variant="outline"
                                className="w-full"
                                onClick={handleClear}
                                disabled={creating}
                            >
                                {t('dailyLogPage.clear')}
                            </Button>

                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    )
}
