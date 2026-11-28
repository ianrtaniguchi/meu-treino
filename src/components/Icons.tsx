import type { ReactNode } from 'react'

const P: Record<string, ReactNode> = {
  treino: <path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11" />,
  dieta: <path d="M7 3v6a2 2 0 0 0 4 0V3M9 11v10M17 3c-2.2 1.6-3 4-3 7h3v11" />,
  corpo: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  assistente: (
    <>
      <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
      <path d="M18.5 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1zM5.5 16l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7.7-1.6z" />
    </>
  ),
  noticias: <path d="M4 5h13v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2V5zm13 4h3v10a2 2 0 0 1-2 2M8 9h5M8 13h5M8 17h3" />,
  onibus: <path d="M5 6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v10a2 2 0 0 1-2 2v2h-2v-2H9v2H7v-2a2 2 0 0 1-2-2V6zm0 6h14M8.5 15h.01M15.5 15h.01" />,
  faculdade: <path d="M3 9.5 12 4l9 5.5-9 5.5-9-5.5zm3.5 2.2V17c3.5 2.5 7.5 2.5 11 0v-5.3M21 10v6" />,
  gastos: (
    <>
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H20v14H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12" />
      <path d="M20 11h-4a2 2 0 0 0 0 4h4" />
      <path d="M16 13h.01" />
    </>
  ),
  config: <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" />,
  settings: <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5v2m0 13v2m9-8h-2m-14 0H3m15.36-6.36-1.42 1.42M7.06 16.94l-1.42 1.42m12.72 0-1.42-1.42M7.06 7.06 5.64 5.64" />,
  hoje: <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  image: <path d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15.5 9h.01" />,
  camera: <path d="M4 7h3l1.5-2h7L17 7h3v12H4zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" />,
}

export type IconName =
  | 'treino'
  | 'dieta'
  | 'corpo'
  | 'assistente'
  | 'noticias'
  | 'onibus'
  | 'faculdade'
  | 'gastos'
  | 'config'
  | 'settings'
  | 'hoje'
  | 'image'
  | 'camera'

export default function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      {P[name]}
    </svg>
  )
}
