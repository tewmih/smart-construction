'use client'

import { useEffect, useState } from 'react'
import { getUnreadMessageCount } from './api'

const POLL_INTERVAL_MS = 60_000

/**
 * Returns the current unread-message count, refreshed every 60s and on window focus.
 * Silent on errors — the bell badge should never break the page.
 *
 * Designed to be safe to mount in multiple places; each hook does its own fetch.
 * For most layouts there's only one Bell on screen at a time, so the overhead is fine.
 */
export function useUnreadCount(): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      try {
        const res = await getUnreadMessageCount()
        if (!cancelled) setCount(res?.count ?? 0)
      } catch {
        // silent
      }
    }

    refresh()
    const id = window.setInterval(refresh, POLL_INTERVAL_MS)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return count
}
