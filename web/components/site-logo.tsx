import Image from 'next/image'
import { cn } from '@/lib/utils'

interface SiteLogoProps {
  className?: string
  imageClassName?: string
  textClassName?: string
  showText?: boolean
  size?: number
}

const logoSrc = '/logo-construction%20pro-1.png'

export function SiteLogo({
  className,
  imageClassName,
  textClassName,
  showText = true,
  size = 40,
}: SiteLogoProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Image
        src={logoSrc}
        alt="Foresite logo"
        width={size}
        height={size}
        className={cn('object-contain flex-shrink-0 rounded-xl', imageClassName)}
        priority
      />
      {showText && (
        <span className={cn('font-bold', textClassName ?? 'text-xl')}>
          Foresite
        </span>
      )}
    </div>
  )
}
