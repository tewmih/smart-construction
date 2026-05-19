'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Building2,
  Plus,
  MapPin,
  Calendar,
  TrendingUp,
  Users,
  ArrowRight,
  Loader2,
} from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { fetchMyProjects } from '@/lib/api'
import type { ProjectListItem } from '@/lib/api-types'
import { roleLabels, statusColors } from '@/lib/domain'
import { useLanguage } from '@/lib/language-context'

interface ProjectSelectionModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProjectSelectionModal({ open, onOpenChange }: ProjectSelectionModalProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { t } = useLanguage()
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !user) return
    let cancelled = false
      ; (async () => {
        setLoading(true)
        setError(null)
        try {
          const visible = await fetchMyProjects(user!.id)
          if (!cancelled) setProjects(visible)
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load projects')
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    return () => {
      cancelled = true
    }
  }, [open, user?.id])

  if (!user) return null

  // const canCreate =
  //   user.is_admin ||
  //   projects.length === 0 ||
  //   projects.some((p) => p.my_role === 'project_manager')

  const handleProjectSelect = (project: ProjectListItem) => {
    router.push(`/dashboard/${project.id}`)
    onOpenChange(false)
  }

  const handleCreateProject = () => {
    router.push('/dashboard/new-project')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b border-border">
          <DialogTitle className="text-xl flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            {t('projectModal.selectProject')}
          </DialogTitle>
          <DialogDescription>
            {t('projectModal.selectProjectDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="p-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium text-sm text-muted-foreground">
                {t('projectModal.yourProjects').replace('{count}', String(projects.length))}
              </h3>
            </div>

            {loading && (
              <div className="flex justify-center py-12 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
              </div>
            )}

            {error && (
              <p className="text-center text-sm text-destructive py-6">{error}</p>
            )}

            {!loading && !error && projects.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <Building2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{t('projectModal.noProjects')}</p>
                <p className="text-sm mt-2">{t('projectModal.createFirstProject')}</p>
              </div>
            )}

            {!loading && !error && projects.length > 0 && (
              <ScrollArea className="h-100 pr-4 -mr-4">
                <div className="space-y-3">
                  {projects.map((project) => {
                    const progressPct = Math.min(
                      100,
                      Math.max(0, Number(project.overall_progress_pct ?? 0)) || 0,
                    )
                    const statusClass =
                      statusColors[project.status] ?? 'bg-muted text-muted-foreground'
                    const roleLabel = roleLabels[project.my_role] ?? 'Team member'
                    return (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => handleProjectSelect(project)}
                        className="w-full p-4 rounded-lg border border-border hover:border-primary/50 hover:bg-muted/50 transition-all text-left group cursor-pointer"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold text-foreground truncate">
                                {project.name}
                              </h4>
                              <Badge
                                variant="secondary"
                                className={`${statusClass} shrink-0`}
                              >
                                {String(project.status ?? 'unknown').replace('_', ' ')}
                              </Badge>
                            </div>

                            <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3">
                              <span className="flex items-center gap-1">
                                <MapPin className="h-3.5 w-3.5" />
                                {project.location || project.client_name || '—'}
                              </span>
                              {project.planned_end_date && (
                                <span className="flex items-center gap-1">
                                  <Calendar className="h-3.5 w-3.5" />
                                  {new Date(project.planned_end_date).toLocaleDateString('en-US', {
                                    month: 'short',
                                    year: 'numeric',
                                  })}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-2">
                                <Users className="h-4 w-4 text-primary" />
                                <Badge variant="outline" className="font-normal">
                                  {roleLabel}
                                </Badge>
                              </div>

                              <div className="flex items-center gap-2">
                                <TrendingUp className="h-4 w-4 text-accent" />
                                <span className="text-sm font-medium">
                                  {progressPct.toFixed(1)}% {t('projectModal.complete')}
                                </span>
                              </div>
                            </div>
                          </div>

                          <ArrowRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0 mt-1" />
                        </div>

                        <div className="mt-3 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full transition-all"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </button>
                    )
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>

        {/* Create Project Button - Always Visible */}
        <div className="border-t border-border px-6 py-4">
          <Button
            onClick={handleCreateProject}
            className="w-full h-auto py-3 justify-center gap-2"
            variant="default"
          >
            <Plus className="h-5 w-5" />
            {t('projectModal.createNewProject')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
