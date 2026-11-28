import { useEffect, useState } from 'react'

export type AppTheme = 'dark' | 'light' | 'baby'

export const THEME_STORAGE_KEY = 'meu-treino-theme'

export const THEME_META_COLORS: Record<AppTheme, string> = {
  dark: '#0b0d11',
  light: '#f5f4f0',
  baby: '#faf2f5',
}

export const THEME_OPTIONS: Array<{
  id: AppTheme
  label: string
  subtitle: string
  bgPreview: string
  accentPreview: string
}> = [
  {
    id: 'dark',
    label: 'Obsidian',
    subtitle: 'noturno frio · ouro fosco',
    bgPreview: '#0b0d11',
    accentPreview: '#b89b5e',
  },
  {
    id: 'light',
    label: 'Editorial',
    subtitle: 'papel quente · bronze',
    bgPreview: '#f5f4f0',
    accentPreview: '#8c6d32',
  },
  {
    id: 'baby',
    label: 'Quartzo',
    subtitle: 'rosa sóbrio · champanhe',
    bgPreview: '#faf2f5',
    accentPreview: '#b55d7a',
  },
]

type ThemeListener = (theme: AppTheme) => void
const listeners = new Set<ThemeListener>()

export function isValidTheme(val: unknown): val is AppTheme {
  return val === 'dark' || val === 'light' || val === 'baby'
}

export function getSavedTheme(): AppTheme {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(THEME_STORAGE_KEY)
      if (isValidTheme(raw)) return raw
    }
  } catch {
    // ignora em ambiente sem localStorage
  }
  return 'dark'
}

let currentTheme: AppTheme = getSavedTheme()

export function applyTheme(theme: AppTheme): void {
  const next: AppTheme = isValidTheme(theme) ? theme : 'dark'
  currentTheme = next

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    }
  } catch {
    // ignora
  }

  if (typeof document !== 'undefined') {
    const bg = THEME_META_COLORS[next]
    document.documentElement.setAttribute('data-theme', next)
    document.documentElement.style.backgroundColor = bg
    if (document.body) {
      document.body.style.backgroundColor = bg
    }
    const metaTheme = document.querySelector('meta[name="theme-color"]')
    if (metaTheme) {
      metaTheme.setAttribute('content', bg)
    }
  }

  for (const fn of listeners) {
    fn(next)
  }
}

export function initTheme(): AppTheme {
  const saved = getSavedTheme()
  applyTheme(saved)
  return saved
}

export function useTheme(): [AppTheme, (t: AppTheme) => void] {
  const [theme, setThemeState] = useState<AppTheme>(() => currentTheme)

  useEffect(() => {
    const fn: ThemeListener = (t) => setThemeState(t)
    listeners.add(fn)
    fn(currentTheme)
    return () => {
      listeners.delete(fn)
    }
  }, [])

  return [theme, applyTheme]
}
