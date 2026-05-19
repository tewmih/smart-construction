'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import Image from 'next/image'
import { useAuth } from '@/lib/auth-context'
import { GoogleSignInButton } from '@/components/google-sign-in-button'
import { useLanguage } from '@/lib/language-context'
import { LanguagePicker } from '@/components/language-picker'

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  )
}

function SignupForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { signup, isLoading } = useAuth()
  const { t } = useLanguage()
  const [showPassword, setShowPassword] = useState(false)
  const invitedEmail = searchParams.get('email') || ''
  const [formData, setFormData] = useState({
    full_name: '',
    email: invitedEmail,
    phone_number: '',
    password: '',
    confirm_password: '',
  })
  const [error, setError] = useState('')

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!formData.full_name || !formData.email || !formData.password) {
      setError('Please fill in all required fields')
      return
    }

    if (formData.password !== formData.confirm_password) {
      setError('Passwords do not match')
      return
    }

    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    const result = await signup({
      full_name: formData.full_name,
      email: formData.email,
      phone_number: formData.phone_number || undefined,
      password: formData.password,
    })

    if (result.success) {
      router.push('/login')
    } else {
      setError(result.error || 'Signup failed')
    }
  }

  return (
    <div className="min-h-screen bg-primary flex">
      {/* Left Panel - Branding */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12">
        <div className="flex items-center justify-between text-primary-foreground w-full">
          <div className="flex items-center gap-3">
            <Image src="/logo-construction pro-1.png" alt="Foresite" width={48} height={48} className="h-30 w-30 object-contain" />
            <span className="font-bold text-2xl">Foresite</span>
          </div>
          <LanguagePicker />
        </div>

        <div className="space-y-6">
          <h1 className="text-4xl font-bold text-primary-foreground text-balance">
            {t('auth.leftTitleSignup')}
          </h1>
          <p className="text-lg text-primary-foreground/80 max-w-md">
            {t('auth.leftSubtitleSignup')}
          </p>
          <ul className="space-y-3 text-primary-foreground/80">
            <li className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-accent" />
              {t('auth.bullet1')}
            </li>
            <li className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-accent" />
              {t('auth.bullet2')}
            </li>
            <li className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-accent" />
              {t('auth.bullet3')}
            </li>
          </ul>
        </div>

        <p className="text-sm text-primary-foreground/60">
          &copy; {new Date().getFullYear()} {t('footer.allRightsReserved')}
        </p>
      </div>

      {/* Right Panel - Signup Form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-background">
        <Card className="w-full max-w-md border-0 shadow-lg">
          <CardHeader className="space-y-1 text-center">
            <div className="flex items-center justify-between mb-4 lg:hidden w-full">
              <div className="flex items-center gap-2">
                <Image src="/logo-construction pro-1.png" alt="Foresite" width={40} height={40} className="h-10 w-10 object-contain" />
                <span className="font-bold text-xl text-foreground">Foresite</span>
              </div>
              <LanguagePicker />
            </div>
            </div>
            <CardTitle className="text-2xl">{t('auth.signupTitle')}</CardTitle>
            <CardDescription>
              {t('auth.signupSubtitle')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="full_name">{t('auth.fullNameLabel')}</Label>
                <Input
                  id="full_name"
                  name="full_name"
                  type="text"
                  placeholder={t('auth.fullNamePlaceholder')}
                  value={formData.full_name}
                  onChange={handleChange}
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.emailLabel')} *</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder={t('auth.emailPlaceholder')}
                  value={formData.email}
                  onChange={handleChange}
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">{t('auth.phoneLabel')}</Label>
                <Input
                  id="phone_number"
                  name="phone_number"
                  type="tel"
                  placeholder={t('auth.phonePlaceholder')}
                  value={formData.phone_number}
                  onChange={handleChange}
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.passwordLabel')} *</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder={t('auth.createPasswordPlaceholder')}
                    value={formData.password}
                    onChange={handleChange}
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm_password">{t('auth.confirmPasswordLabel')}</Label>
                <Input
                  id="confirm_password"
                  name="confirm_password"
                  type="password"
                  placeholder={t('auth.confirmPasswordPlaceholder')}
                  value={formData.confirm_password}
                  onChange={handleChange}
                  disabled={isLoading}
                />
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('auth.signingUp')}
                  </>
                ) : (
                  t('auth.signupBtn')
                )}
              </Button>

              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">
                    {t('auth.orSignupWith')}
                  </span>
                </div>
              </div>

              <GoogleSignInButton onError={setError} />

              <p className="text-center text-sm text-muted-foreground">
                {t('auth.alreadyHaveAccount')}{' '}
                <Link href="/login" className="text-accent hover:underline font-medium">
                  {t('auth.signinLink')}
                </Link>
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
