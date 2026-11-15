import { useEffect, useState } from 'react'
import { autoSnapshotIfDue } from './data/backup'
import { db, setSetting } from './data/db'
import { ensureSeed } from './data/seed'
import { useSetting } from './hooks'
import Treino from './tabs/Treino'
import Dieta from './tabs/Dieta'
import Corpo from './tabs/Corpo'
import Config from './tabs/Config'

type Tab = 'treino' | 'dieta' | 'corpo' | 'config'
const TABS: [Tab, string, string][] = [
  ['treino', '🏋️', 'Treino'],
  ['dieta', '🍽️', 'Dieta'],
  ['corpo', '📏', 'Corpo'],
  ['config', '⚙️', 'Config'],
]
const WEEK = 7 * 24 * 3600 * 1000

export default function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('treino')
  const onboarded = useSetting<boolean>('onboardingDone', false)
  const lastBackup = useSetting<number | null>('lastBackupAt', null)
  const firstUse = useSetting<number | null>('firstUseAt', null)

  useEffect(() => {
    ;(async () => {
      try {
        await db.open()
        await ensureSeed()
        // pede ao navegador para não apagar os dados por falta de espaço
        if (navigator.storage?.persist) await navigator.storage.persist()
        await autoSnapshotIfDue()
        setReady(true)
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      }
    })()
  }, [])

  if (error)
    return (
      <div className="scroll">
        <h1>Erro ao abrir o banco de dados</h1>
        <p className="muted">{error}</p>
        <p className="muted">Se estiver em modo privado do Safari, abra o app instalado na Tela de Início.</p>
      </div>
    )
  if (!ready || onboarded === undefined) return null

  if (!onboarded)
    return (
      <div className="scroll">
        <div className="hero">
          <div className="big">📲</div>
          <h1>Antes de começar</h1>
          <p style={{ fontSize: 18 }}>
            <b>Instale o app na Tela de Início ANTES de registrar dados.</b> No iPhone, os dados do Safari e do app
            instalado são separados.
          </p>
          <p className="muted">
            No Safari: toque em Compartilhar → “Adicionar à Tela de Início”. Depois abra o app pelo ícone e use sempre
            por ele. Faça backups com frequência em Config.
          </p>
          <button className="primary block" onClick={() => setSetting('onboardingDone', true)}>
            Entendi
          </button>
        </div>
      </div>
    )

  const ref = lastBackup ?? firstUse ?? Date.now()
  const stale = Date.now() - ref > WEEK
  const days = Math.floor((Date.now() - ref) / 86400000)

  return (
    <div className="app">
      <div className="scroll">
        {stale && (
          <div className="banner" onClick={() => setTab('config')}>
            <span className="grow">
              {lastBackup ? `Último backup há ${days} dias.` : 'Você ainda não fez nenhum backup.'} Toque para fazer agora.
            </span>
          </div>
        )}
        {tab === 'treino' && <Treino />}
        {tab === 'dieta' && <Dieta />}
        {tab === 'corpo' && <Corpo />}
        {tab === 'config' && <Config />}
      </div>
      <nav className="tabbar">
        {TABS.map(([k, ic, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <span className="ic">{ic}</span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}
