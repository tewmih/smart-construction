'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/lib/auth-context'
import {
    listAllAnnouncements,
    createAnnouncement,
    updateAnnouncement,
    deleteAnnouncement,
} from '@/lib/api'
import type { AnnouncementItem } from '@/lib/api-types'
import { Loader2, Plus, Edit, Trash2, ArrowLeft } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

export default function AdminAnnouncementsPage() {
    const router = useRouter()
    const { user, isAuthenticated, isLoading: authLoading } = useAuth()
    const { toast } = useToast()
    const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingAnnouncement, setEditingAnnouncement] = useState<AnnouncementItem | null>(null)
    const [formData, setFormData] = useState({
        content: '',
        priority: 'normal',
        target_audience: 'all' as 'all' | 'admins' | 'project_managers',
        expires_at: '',
    })
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push('/login')
        }
        if (!authLoading && isAuthenticated && !user?.is_admin) {
            router.push('/dashboard')
        }
    }, [authLoading, isAuthenticated, user, router])

    const loadAnnouncements = async () => {
        setLoading(true)
        setError(null)
        try {
            const data = await listAllAnnouncements()
            setAnnouncements(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load announcements')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        if (!isAuthenticated || !user?.is_admin) return
        loadAnnouncements()
    }, [isAuthenticated, user])

    const handleOpenDialog = (announcement?: AnnouncementItem) => {
        if (announcement) {
            setEditingAnnouncement(announcement)
            setFormData({
                content: announcement.content,
                priority: announcement.priority,
                target_audience: (announcement.target_audience as 'all' | 'admins' | 'project_managers') || 'all',
                expires_at: announcement.expires_at
                    ? new Date(announcement.expires_at).toISOString().slice(0, 16)
                    : '',
            })
        } else {
            setEditingAnnouncement(null)
            setFormData({
                content: '',
                priority: 'normal',
                target_audience: 'all',
                expires_at: '',
            })
        }
        setDialogOpen(true)
    }

    const handleSave = async () => {
        if (!formData.content) {
            toast({
                title: 'Error',
                description: 'Content is required',
                variant: 'destructive',
            })
            return
        }

        const derivedTitle = formData.content.trim().split(/\s+/).slice(0, 6).join(' ') || 'Announcement'

        setSaving(true)
        try {
            const payload = {
                title: derivedTitle,
                content: formData.content,
                priority: formData.priority,
                target_audience: formData.target_audience,
                expires_at: formData.expires_at || undefined,
            }

            if (editingAnnouncement) {
                await updateAnnouncement(editingAnnouncement.id, payload)
                toast({
                    title: 'Success',
                    description: 'Announcement updated successfully',
                })
            } else {
                await createAnnouncement(payload)
                toast({
                    title: 'Success',
                    description: 'Announcement created successfully',
                })
            }

            setDialogOpen(false)
            loadAnnouncements()
        } catch (err) {
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to save announcement',
                variant: 'destructive',
            })
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async (id: string) => {
        if (!confirm('Are you sure you want to delete this announcement?')) return

        try {
            await deleteAnnouncement(id)
            toast({
                title: 'Success',
                description: 'Announcement deleted successfully',
            })
            loadAnnouncements()
        } catch (err) {
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to delete announcement',
                variant: 'destructive',
            })
        }
    }

    const handleToggleActive = async (announcement: AnnouncementItem) => {
        try {
            await updateAnnouncement(announcement.id, {
                is_active: !announcement.is_active,
            })
            toast({
                title: 'Success',
                description: `Announcement ${announcement.is_active ? 'deactivated' : 'activated'}`,
            })
            loadAnnouncements()
        } catch (err) {
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to update announcement',
                variant: 'destructive',
            })
        }
    }

    if (authLoading || (loading && announcements.length === 0)) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }

    if (!isAuthenticated || !user?.is_admin) return null

    const getPriorityBadge = (priority: string) => {
        switch (priority) {
            case 'urgent':
                return <Badge variant="destructive">Urgent</Badge>
            case 'high':
                return <Badge className="bg-orange-500">High</Badge>
            case 'normal':
                return <Badge variant="secondary">Normal</Badge>
            case 'low':
                return <Badge variant="outline">Low</Badge>
            default:
                return <Badge variant="secondary">{priority}</Badge>
        }
    }

    return (
        <div className="p-8 space-y-8">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Announcements</h1>
                    <p className="text-muted-foreground mt-2">Create and manage platform-wide announcements</p>
                </div>
                <Button onClick={() => handleOpenDialog()} className="gap-2">
                    <Plus className="h-4 w-4" />
                    New Announcement
                </Button>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>All Announcements</CardTitle>
                    <CardDescription>Manage announcements visible to all users</CardDescription>
                </CardHeader>
                <CardContent>
                    {error ? (
                        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
                            {error}
                        </div>
                    ) : loading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : announcements.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                            No announcements yet.
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {announcements.map((announcement) => (
                                <div key={announcement.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate font-bold text-foreground">{announcement.content}</p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {getPriorityBadge(announcement.priority)}
                                        {announcement.is_active ? (
                                            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Active</Badge>
                                        ) : (
                                            <Badge variant="outline" className="bg-gray-50 text-gray-700 border-gray-200">Inactive</Badge>
                                        )}
                                        <Badge variant="outline" className="text-[10px]">
                                            {announcement.expires_at
                                                ? new Date(announcement.expires_at).toLocaleDateString('en-US', {
                                                    month: 'short',
                                                    day: 'numeric',
                                                    year: 'numeric',
                                                })
                                                : 'No expiry'}
                                        </Badge>
                                        <Button variant="ghost" size="icon" onClick={() => handleToggleActive(announcement)}>
                                            {announcement.is_active ? '—' : '+'}
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(announcement)}>
                                            <Edit className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => handleDelete(announcement.id)}
                                            className="text-destructive hover:text-destructive"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{editingAnnouncement ? 'Edit Announcement' : 'Create Announcement'}</DialogTitle>
                        <DialogDescription>
                            {editingAnnouncement
                                ? 'Update the announcement details'
                                : 'Create a new platform-wide announcement'}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="content">Content</Label>
                            <Textarea
                                id="content"
                                value={formData.content}
                                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                                placeholder="Announcement content"
                                rows={4}
                            />
                        </div>

                        <div className="grid gap-4 sm:grid-cols-3">
                            <div className="space-y-2">
                                <Label htmlFor="priority">Priority</Label>
                                <Select
                                    value={formData.priority}
                                    onValueChange={(value) => setFormData({ ...formData, priority: value })}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="low">Low</SelectItem>
                                        <SelectItem value="normal">Normal</SelectItem>
                                        <SelectItem value="high">High</SelectItem>
                                        <SelectItem value="urgent">Urgent</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="target_audience">Audience</Label>
                                <Select
                                    value={formData.target_audience}
                                    onValueChange={(value) => setFormData({ ...formData, target_audience: value as 'all' | 'admins' | 'project_managers' })}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Users</SelectItem>
                                        <SelectItem value="admins">Admins Only</SelectItem>
                                        <SelectItem value="project_managers">Project Managers</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="expires_at">Expires At (Optional)</Label>
                                <Input
                                    id="expires_at"
                                    type="datetime-local"
                                    value={formData.expires_at}
                                    onChange={(e) => setFormData({ ...formData, expires_at: e.target.value })}
                                />
                            </div>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={saving}>
                            {saving ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Saving...
                                </>
                            ) : editingAnnouncement ? (
                                'Update'
                            ) : (
                                'Create'
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
