'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/lib/auth-context'
import { listUsers, promoteUser, demoteUser, activateUser, deactivateUser } from '@/lib/api'
import type { UserListItem } from '@/lib/api-types'
import { Loader2, MoreVertical, Search, Shield, ShieldOff, UserCheck, UserX, ArrowLeft, ChevronLeft, ChevronRight, ArrowDown, ArrowUp } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

export default function AdminUsersPage() {
    const router = useRouter()
    const { user, isAuthenticated, isLoading: authLoading } = useAuth()
    const { toast } = useToast()
    const [users, setUsers] = useState<UserListItem[]>([])
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(1)
    const [sortBy, setSortBy] = useState<string>('created_at')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState<string>('all')
    const [roleFilter, setRoleFilter] = useState<string>('all')

    const PAGE_SIZE = 25

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push('/login')
        }
        if (!authLoading && isAuthenticated && !user?.is_admin) {
            router.push('/dashboard')
        }
    }, [authLoading, isAuthenticated, user, router])

    const loadUsers = async () => {
        setLoading(true)
        setError(null)
        try {
            const params: Record<string, unknown> = {
                page,
                limit: PAGE_SIZE,
                sort_by: sortBy,
                sort_dir: sortDir,
            }
            if (searchQuery) params.search = searchQuery
            if (statusFilter !== 'all') params.is_active = statusFilter === 'active'
            if (roleFilter !== 'all') params.is_admin = roleFilter === 'admin'

            const res = await listUsers(params)
            setUsers(res.data)
            setTotal(res.total)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load users')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        if (!isAuthenticated || !user?.is_admin) return
        loadUsers()
    }, [isAuthenticated, user, searchQuery, statusFilter, roleFilter, page, sortBy, sortDir])

    useEffect(() => {
        setPage(1)
    }, [searchQuery, statusFilter, roleFilter])

    const toggleSort = (col: string) => {
        if (sortBy === col) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
        } else {
            setSortBy(col)
            setSortDir('asc')
        }
    }

    const sortIcon = (col: string) => {
        if (sortBy !== col) return null
        return sortDir === 'asc' ? <ArrowUp className="ml-1 h-3 w-3 inline" /> : <ArrowDown className="ml-1 h-3 w-3 inline" />
    }

    const formatRelative = (iso?: string | null) => {
        if (!iso) return 'Never'
        const diff = Date.now() - new Date(iso).getTime()
        const days = Math.floor(diff / 86_400_000)
        if (days < 1) return 'Today'
        if (days === 1) return 'Yesterday'
        if (days < 30) return `${days}d ago`
        if (days < 365) return `${Math.floor(days / 30)}mo ago`
        return `${Math.floor(days / 365)}y ago`
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

    const handlePromote = async (userId: string) => {
        try {
            await promoteUser(userId)
            toast({
                title: 'Success',
                description: 'User promoted to admin',
            })
            loadUsers()
        } catch (err) {
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to promote user',
                variant: 'destructive',
            })
        }
    }

    const handleDemote = async (userId: string) => {
        try {
            await demoteUser(userId)
            toast({
                title: 'Success',
                description: 'User demoted to regular user',
            })
            loadUsers()
        } catch (err) {
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to demote user',
                variant: 'destructive',
            })
        }
    }

    const handleActivate = async (userId: string) => {
        try {
            await activateUser(userId)
            toast({
                title: 'Success',
                description: 'User activated',
            })
            loadUsers()
        } catch (err) {
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to activate user',
                variant: 'destructive',
            })
        }
    }

    const handleDeactivate = async (userId: string) => {
        try {
            await deactivateUser(userId)
            toast({
                title: 'Success',
                description: 'User deactivated',
            })
            loadUsers()
        } catch (err) {
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to deactivate user',
                variant: 'destructive',
            })
        }
    }

    if (authLoading || (loading && users.length === 0)) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }

    if (!isAuthenticated || !user?.is_admin) return null

    return (
        <div className="p-8 space-y-8">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
                <p className="text-muted-foreground mt-2">Manage system users, roles, and permissions</p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>All Users</CardTitle>
                    <CardDescription>View and manage all users in the system</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Filters */}
                    <div className="flex flex-col sm:flex-row gap-4">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search by name or email..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="pl-9"
                            />
                        </div>
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="w-full sm:w-[180px]">
                                <SelectValue placeholder="Status" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Status</SelectItem>
                                <SelectItem value="active">Active</SelectItem>
                                <SelectItem value="inactive">Inactive</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={roleFilter} onValueChange={setRoleFilter}>
                            <SelectTrigger className="w-full sm:w-[180px]">
                                <SelectValue placeholder="Role" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Roles</SelectItem>
                                <SelectItem value="admin">Admin</SelectItem>
                                <SelectItem value="user">User</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    {error && (
                        <div className="p-4 border border-destructive/20 bg-destructive/5 rounded-lg text-sm text-destructive">
                            {error}
                        </div>
                    )}

                    {/* Users Table */}
                    <div className="border rounded-lg">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('full_name')}>
                                        Name {sortIcon('full_name')}
                                    </TableHead>
                                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('email')}>
                                        Email {sortIcon('email')}
                                    </TableHead>
                                    <TableHead>Phone</TableHead>
                                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('is_admin')}>
                                        Role {sortIcon('is_admin')}
                                    </TableHead>
                                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('is_active')}>
                                        Status {sortIcon('is_active')}
                                    </TableHead>
                                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('created_at')}>
                                        Joined {sortIcon('created_at')}
                                    </TableHead>
                                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('last_login_at')}>
                                        Last Login {sortIcon('last_login_at')}
                                    </TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {loading ? (
                                    <TableRow>
                                        <TableCell colSpan={8} className="text-center py-8">
                                            <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                                        </TableCell>
                                    </TableRow>
                                ) : users.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                                            No users found
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    users.map((u) => (
                                        <TableRow key={u.id}>
                                            <TableCell className="font-medium">{u.full_name}</TableCell>
                                            <TableCell>{u.email}</TableCell>
                                            <TableCell>{u.phone_number || '—'}</TableCell>
                                            <TableCell>
                                                {u.is_admin ? (
                                                    <Badge variant="default">Admin</Badge>
                                                ) : (
                                                    <Badge variant="secondary">User</Badge>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                {u.is_active ? (
                                                    <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                                        Active
                                                    </Badge>
                                                ) : (
                                                    <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                                                        Inactive
                                                    </Badge>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-sm text-muted-foreground">
                                                {new Date(u.created_at).toLocaleDateString('en-US', {
                                                    month: 'short',
                                                    day: 'numeric',
                                                    year: 'numeric',
                                                })}
                                            </TableCell>
                                            <TableCell className="text-sm text-muted-foreground">
                                                <span title={u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never logged in'}>
                                                    {formatRelative(u.last_login_at)}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button variant="ghost" size="icon" disabled={u.id === user.id}>
                                                            <MoreVertical className="h-4 w-4" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end">
                                                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                                        <DropdownMenuSeparator />
                                                        {u.is_admin ? (
                                                            <DropdownMenuItem onClick={() => handleDemote(u.id)}>
                                                                <ShieldOff className="mr-2 h-4 w-4" />
                                                                Demote to User
                                                            </DropdownMenuItem>
                                                        ) : (
                                                            <DropdownMenuItem onClick={() => handlePromote(u.id)}>
                                                                <Shield className="mr-2 h-4 w-4" />
                                                                Promote to Admin
                                                            </DropdownMenuItem>
                                                        )}
                                                        <DropdownMenuSeparator />
                                                        {u.is_active ? (
                                                            <DropdownMenuItem
                                                                onClick={() => handleDeactivate(u.id)}
                                                                className="text-destructive"
                                                            >
                                                                <UserX className="mr-2 h-4 w-4" />
                                                                Deactivate
                                                            </DropdownMenuItem>
                                                        ) : (
                                                            <DropdownMenuItem onClick={() => handleActivate(u.id)}>
                                                                <UserCheck className="mr-2 h-4 w-4" />
                                                                Activate
                                                            </DropdownMenuItem>
                                                        )}
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </div>

                    {total > 0 && (
                        <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">
                                Page {page} of {totalPages} · {total.toLocaleString()} user{total === 1 ? '' : 's'}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage(p => Math.max(1, p - 1))}>
                                    <ChevronLeft className="h-4 w-4" /> Prev
                                </Button>
                                <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                                    Next <ChevronRight className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
