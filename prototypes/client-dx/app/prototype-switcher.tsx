'use client'
// PROTOTYPE UI: floating bottom bar cycling `?variant=` (hidden in production builds).
import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

export function PrototypeSwitcher({ variants, current }: { variants: { key: string; name: string }[]; current: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const index = Math.max(0, variants.findIndex((v) => v.key === current))
  const go = (delta: number) => {
    const next = variants[(index + delta + variants.length) % variants.length]!
    const params = new URLSearchParams(search)
    params.set('variant', next.key)
    router.replace(`${pathname}?${params}`)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (process.env.NODE_ENV === 'production') return null
  return (
    <div className="switcher">
      <button onClick={() => go(-1)}>←</button>
      <span>{variants[index]!.key.toUpperCase()} ({variants[index]!.name})</span>
      <button onClick={() => go(1)}>→</button>
    </div>
  )
}
