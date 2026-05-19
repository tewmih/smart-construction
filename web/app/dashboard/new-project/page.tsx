'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
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
import { ArrowLeft, Loader2, Plus } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { createProject, listClients, listProjects } from '@/lib/api'
import type { ClientListItem } from '@/lib/api-types'
import { SiteLogo } from '@/components/site-logo'
import { useLanguage } from '@/lib/language-context'

function dateInputToApiDateTime(date: string): string | undefined {
  if (!date) return undefined
  return `${date}T00:00:00`
}

export default function NewProjectPage() {
  const router = useRouter()
  const { isAuthenticated } = useAuth()
  const { t } = useLanguage()
  const [isLoading, setIsLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [clientsLoading, setClientsLoading] = useState(true)
  const [clients, setClients] = useState<ClientListItem[]>([])

  // Project form
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    location: '',
    planned_start_date: new Date().toISOString().split('T')[0],
    planned_end_date: new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0],
    total_budget: '',
  })

  // Client selection mode: 'existing' or 'new'
  const [clientMode, setClientMode] = useState<'existing' | 'new'>('existing')
  const [selectedClientId, setSelectedClientId] = useState('')
  const [newClientName, setNewClientName] = useState('')
  const [newClientEmail, setNewClientEmail] = useState('')
  const [newClientTin, setNewClientTin] = useState('')
  const [newClientAddress, setNewClientAddress] = useState('')
  const [newClientPhone, setNewClientPhone] = useState('')

  useEffect(() => {
    if (!isAuthenticated) router.push('/login')
  }, [isAuthenticated, router])

  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
      ; (async () => {
        setClientsLoading(true)
        try {
          const { data: projectsData } = await listProjects({ limit: 100 })
          const allClients: ClientListItem[] = []
          const seenNames = new Set<string>()
          for (const p of projectsData) {
            try {
              const clientsData = await listClients(p.id, { limit: 100 })
              for (const c of clientsData) {
                const normName = c.name.trim().toLowerCase()
                if (!seenNames.has(normName)) {
                  seenNames.add(normName)
                  allClients.push(c)
                }
              }
            } catch (err) {
              console.error('Failed to load clients for project', p.id, err)
            }
          }
          if (!cancelled) {
            setClients(allClients)
            if (allClients.length === 0) {
              setClientMode('new')
            } else {
              setClientMode('existing')
            }
          }
        } catch {
          if (!cancelled) {
            setClients([])
            setClientMode('new')
          }
        } finally {
          if (!cancelled) setClientsLoading(false)
        }
      })()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }))
  }

  const selectedClient = clients.find((c) => c.id === selectedClientId)

  const getClientFields = (): { client_name: string; client_email: string } | null => {
    if (clientMode === 'existing') {
      if (!selectedClient) return null
      return {
        client_name: selectedClient.name,
        client_email: selectedClient.contact_email || '',
      }
    }
    if (!newClientName.trim() || !newClientEmail.trim()) return null
    return {
      client_name: newClientName.trim(),
      client_email: newClientEmail.trim(),
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const clientFields = getClientFields()
    if (!clientFields) {
      setSubmitError(t('newProject.selectClientErr'))
      return
    }
    const totalBudget = Number.parseFloat(formData.total_budget)
    if (!Number.isFinite(totalBudget) || totalBudget < 0) {
      setSubmitError(t('newProject.validBudgetErr'))
      return
    }
    setSubmitError(null)
    setIsLoading(true)
    try {
      const created = await createProject({
        name: formData.name.trim(),
        total_budget: totalBudget,
        description: formData.description.trim() || null,
        location: formData.location.trim() || null,
        planned_start_date: dateInputToApiDateTime(formData.planned_start_date) ?? null,
        planned_end_date: dateInputToApiDateTime(formData.planned_end_date) ?? null,
        client_name: clientFields.client_name,
        client_email: clientFields.client_email,
        client_tin_number: newClientTin.trim() || null,
        client_address: newClientAddress.trim() || null,
        client_phone: newClientPhone.trim() || null,
      })

      // Show resolved client name if different from what was typed
      const response = created as unknown as { client?: { name: string } }
      if (
        clientMode === 'new' &&
        response.client?.name &&
        response.client.name !== clientFields.client_name
      ) {
        alert(t('newProject.linkedExistingClient').replace('{name}', response.client.name))
      }

      router.push(`/dashboard/${created.id}`)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('newProject.failedToCreate'))
    } finally {
      setIsLoading(false)
    }
  }

  const isClientValid = clientMode === 'existing'
    ? !!selectedClientId
    : !!(newClientName.trim() && newClientEmail.trim())

  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard">
              <Button variant="ghost" size="icon" aria-label="Back to dashboard">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <Link href="/" className="flex items-center gap-2">
              <SiteLogo imageClassName="h-12 w-12" textClassName="text-xl text-foreground" />
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{t('newProject.title')}</CardTitle>
            <CardDescription>
              {t('newProject.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="name">{t('newProject.projectName')}</Label>
                <Input
                  id="name"
                  name="name"
                  placeholder={t('newProject.projectNamePlaceholder')}
                  value={formData.name}
                  onChange={handleChange}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">{t('newProject.projectDesc')}</Label>
                <Textarea
                  id="description"
                  name="description"
                  placeholder={t('newProject.projectDescPlaceholder')}
                  rows={3}
                  value={formData.description}
                  onChange={handleChange}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="location">{t('newProject.location')}</Label>
                <Input
                  id="location"
                  name="location"
                  placeholder={t('newProject.locationPlaceholder')}
                  value={formData.location}
                  onChange={handleChange}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="total_budget">{t('newProject.totalBudget')}</Label>
                <Input
                  id="total_budget"
                  name="total_budget"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder={t('newProject.totalBudgetPlaceholder')}
                  value={formData.total_budget}
                  onChange={handleChange}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {t('newProject.totalBudgetDesc')}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="planned_start_date">{t('newProject.plannedStart')}</Label>
                  <Input
                    id="planned_start_date"
                    name="planned_start_date"
                    type="date"
                    value={formData.planned_start_date}
                    onChange={handleChange}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="planned_end_date">{t('newProject.plannedEnd')}</Label>
                  <Input
                    id="planned_end_date"
                    name="planned_end_date"
                    type="date"
                    value={formData.planned_end_date}
                    onChange={handleChange}
                    required
                  />
                </div>
              </div>

              {/* Client Section */}
              <div className="space-y-3">
                <Label className="text-base font-semibold">{t('newProject.client')}</Label>

                {clientsLoading ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> {t('newProject.loadingClients')}
                  </p>
                ) : (
                  <>
                    <Select
                      value={clientMode === 'existing' ? selectedClientId : ''}
                      onValueChange={(v) => {
                        setSelectedClientId(v)
                        setClientMode('existing')
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={clients.length === 0 ? t('newProject.noClientsPlaceholder') : t('newProject.selectClient')} />
                      </SelectTrigger>
                      <SelectContent>
                        <div className="max-h-48 overflow-y-auto">
                          {clients.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              <div className="flex flex-col">
                                <span>{c.name}</span>
                                {c.contact_email && (
                                  <span className="text-xs text-muted-foreground">{c.contact_email}</span>
                                )}
                              </div>
                            </SelectItem>
                          ))}
                        </div>
                      </SelectContent>
                    </Select>

                    {clientMode === 'existing' && selectedClient && (
                      <p className="text-xs text-muted-foreground">
                        {t('newProject.selected')} <span className="font-medium">{selectedClient.name}</span>
                        {selectedClient.contact_email && <> — {selectedClient.contact_email}</>}
                      </p>
                    )}

                    {clientMode === 'new' ? (
                      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-4">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium">{t('newProject.newClientDetails')}</p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-xs"
                            onClick={() => {
                              setClientMode('existing')
                              setNewClientName('')
                              setNewClientEmail('')
                              setNewClientTin('')
                              setNewClientAddress('')
                              setNewClientPhone('')
                            }}
                          >
                            {t('newProject.cancel')}
                          </Button>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="client_name">{t('newProject.clientName')}</Label>
                            <Input
                              id="client_name"
                              placeholder={t('newProject.clientNamePlaceholder')}
                              value={newClientName}
                              onChange={(e) => setNewClientName(e.target.value)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="client_email">{t('newProject.clientEmail')}</Label>
                            <Input
                              id="client_email"
                              type="email"
                              placeholder={t('newProject.clientEmailPlaceholder')}
                              value={newClientEmail}
                              onChange={(e) => setNewClientEmail(e.target.value)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="client_tin">{t('newProject.clientTin')}</Label>
                            <Input
                              id="client_tin"
                              placeholder={t('newProject.clientTinPlaceholder')}
                              value={newClientTin}
                              onChange={(e) => setNewClientTin(e.target.value)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="client_phone">{t('newProject.clientPhone')}</Label>
                            <Input
                              id="client_phone"
                              type="tel"
                              placeholder={t('newProject.clientPhonePlaceholder')}
                              value={newClientPhone}
                              onChange={(e) => setNewClientPhone(e.target.value)}
                            />
                          </div>
                          <div className="space-y-2 sm:col-span-2">
                            <Label htmlFor="client_address">{t('newProject.clientAddress')}</Label>
                            <Input
                              id="client_address"
                              placeholder={t('newProject.clientAddressPlaceholder')}
                              value={newClientAddress}
                              onChange={(e) => setNewClientAddress(e.target.value)}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('newProject.clientAutoLinkDesc')}
                        </p>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5 w-full border-dashed"
                        onClick={() => {
                          setClientMode('new')
                          setSelectedClientId('')
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t('newProject.addNewClient')}
                      </Button>
                    )}
                  </>
                )}
              </div>

              {submitError && (
                <p className="text-sm text-destructive" role="alert">
                  {submitError}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-end gap-4 pt-4 border-t border-border">
                <Link href="/dashboard">
                  <Button type="button" variant="outline">
                    {t('newProject.cancel')}
                  </Button>
                </Link>
                <Button type="submit" disabled={isLoading || !isClientValid}>
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('newProject.creating')}
                    </>
                  ) : (
                    t('newProject.createProject')
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
