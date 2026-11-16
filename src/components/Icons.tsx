import type { ReactNode } from 'react'

const P: Record<string, ReactNode> = {
  treino: <path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11" />,
  dieta: <path d="M7 3v6a2 2 0 0 0 4 0V3M9 11v10M17 3c-2.2 1.6-3 4-3 7h3v11" />,
  corpo: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  assistente: <path d="M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h4" />,
  config: <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" />,
}

export default function Icon({ name }: { name: 'treino' | 'dieta' | 'corpo' | 'assistente' | 'config' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {P[name]}
    </svg>
  )
}
