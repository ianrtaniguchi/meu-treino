import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { Seg, Sheet, useUi } from '../components/ui'
import {
  BackupError, createSnapshot, exportBackupToFile, importBackup, listSnapshots, parseBackup, previewBackup,
  restoreSnapshot, type ImportMode,
} from '../data/backup'
import { setSetting } from '../data/db'
import type { Backup } from '../data/types'
import { useSetting } from '../hooks'

const fmtDateTime = (t: number | string) => new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const mb = (n?: number) => (n === undefined ? '—' : `${(n / 1024 / 1024).toFixed(2)} MB`)
const KIND: Record<string, string> = { auto: 'Automático', seguranca: 'Segurança', manual: 'Manual' }

export default function Config() {
  const { toast, confirm } = useUi()
  const lastBackup = useSetting<number | null>('lastBackupAt', null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<{ used?: number; quota?: number }>({})
  const [pending, setPending] = useState<Backup | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const snaps = useLiveQuery(() => listSnapshots(), [], [])

  const refreshStorage = async () => {
    setPersisted((await navigator.storage?.persisted?.()) ?? false)
    const e = await navigator.storage?.estimate?.()
    setUsage({ used: e?.usage, quota: e?.quota })
  }
  useEffect(() => { void refreshStorage() }, [])

  const requestPersist = async () => {
    const ok = (await navigator.storage?.persist?.()) ?? false
    toast(ok ? 'Armazenamento persistente ativado' : 'O iOS não concedeu (instale na Tela de Início e tente de novo)')
    void refreshStorage()
  }

  const doExport = async () => {
    setBusy(true)
    try {
      if (await exportBackupToFile()) {
        await setSetting('lastBackupAt', Date.now())
        toast('Backup exportado')
      }
    } catch (e) {
      toast('Falha ao exportar: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onFile = async (file?: File) => {
    setError('')
    if (!file) return
    try {
      setPending(parseBackup(await file.text()))
    } catch (e) {
      setError(e instanceof BackupError ? e.message : 'Não foi possível ler o arquivo.')
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const doImport = async (mode: ImportMode) => {
    if (!pending) return
    if (mode === 'replace' && !(await confirm('Substituir TODOS os dados atuais pelo backup? Um snapshot de segurança será criado antes.', 'Substituir'))) return
    setBusy(true)
    try {
      await importBackup(pending, mode)
      toast(mode === 'replace' ? 'Dados substituídos pelo backup' : 'Backup mesclado')
      setPending(null)
    } catch (e) {
      setError('Falha na importação (nada foi alterado): ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (id: string, when: string) => {
    if (!(await confirm(`Restaurar o snapshot de ${when}? Os dados atuais serão substituídos (um snapshot de segurança é criado antes).`, 'Restaurar'))) return
    try {
      await restoreSnapshot(id)
      toast('Snapshot restaurado')
    } catch (e) {
      toast('Falha ao restaurar: ' + (e as Error).message)
    }
  }

  const backupAge = lastBackup ? Math.floor((Date.now() - lastBackup) / 86400000) : null
  const gap = useSetting<number>('streakGap', 2) ?? 2
  const p = pending ? previewBackup(pending) : null
  const [mode, setMode] = useState<ImportMode>('merge')

  return (
    <>
      <h1>~/config</h1>

      <h2>armazenamento</h2>
      <div className="card stack">
        <div className="row between"><span>Armazenamento persistente</span><b style={{ color: persisted ? 'var(--accent)' : 'var(--amber)' }}>{persisted === null ? '…' : persisted ? 'Sim' : 'Não'}</b></div>
        <div className="row between"><span>Em uso</span><b>{mb(usage.used)}</b></div>
        <div className="row between"><span>Cota estimada</span><b>{mb(usage.quota)}</b></div>
        {persisted === false && <button className="block" onClick={requestPersist}>Pedir armazenamento persistente</button>}
        <p className="muted small" style={{ margin: 0 }}>Mesmo persistente, faça backups: é a sua garantia contra perda de dados.</p>
      </div>

      <h2>backup</h2>
      <div className="card stack" style={{ borderColor: backupAge === null || backupAge > 7 ? 'var(--amber)' : 'var(--green)' }}>
        <div className="muted small">último backup exportado</div>
        <div className={backupAge === null || backupAge > 7 ? 'big amber' : 'big green'}>{lastBackup ? fmtDateTime(lastBackup) : 'nunca'}</div>
        {backupAge !== null && <div className="muted small">há {backupAge} dia(s)</div>}
        <button className="primary block" disabled={busy} onClick={doExport}>$ exportar backup (json)</button>
        <button className="block" disabled={busy} onClick={() => fileRef.current?.click()}>$ importar backup…</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        {error && <div style={{ color: 'var(--red)' }}>{error}</div>}
      </div>

      <h2>snapshots internos</h2>
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>Cópias de segurança guardadas no próprio aparelho (um automático por semana de uso, os 5 mais recentes de cada tipo). Não substituem o backup exportado.</p>
        <button className="small block" onClick={async () => { await createSnapshot('manual', 'Manual'); toast('Snapshot criado') }}>Criar snapshot agora</button>
        {snaps.length === 0 && <p className="muted">Nenhum snapshot ainda.</p>}
        {snaps.map((s) => (
          <div key={s.id} className="item">
            <div className="grow">
              <div>{fmtDateTime(s.createdAt)} <span className="chip">{KIND[s.kind]}</span></div>
              <div className="muted small">{s.data.tables.sessions.length} treinos · {s.data.tables.meals.length} refeições · {s.data.tables.body.length} pesos</div>
            </div>
            <button className="small" onClick={() => restore(s.id, fmtDateTime(s.createdAt))}>Restaurar</button>
          </div>
        ))}
      </div>

      <h2>treino</h2>
      <div className="card">
        <div className="row between">
          <div className="grow">tolerância do streak<div className="muted small">dias de descanso que mantêm a sequência</div></div>
          <button aria-label="menos" onClick={() => setSetting('streakGap', Math.max(0, gap - 1))}>-</button>
          <b style={{ width: 24, textAlign: 'center' }}>{gap}</b>
          <button aria-label="mais" onClick={() => setSetting('streakGap', Math.min(7, gap + 1))}>+</button>
        </div>
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: 20 }}>Meu Treino · dados apenas neste aparelho · sem rede</p>

      {pending && p && (
        <Sheet title="Importar backup" onClose={() => setPending(null)}>
          <div className="card">
            <div className="muted small">Gerado em {p.exportedAt ? fmtDateTime(p.exportedAt) : '—'}</div>
            <div className="grid3" style={{ marginTop: 8 }}>
              <div className="stat"><b>{p.sessions}</b><span className="muted small">treinos</span></div>
              <div className="stat"><b>{p.meals}</b><span className="muted small">refeições</span></div>
              <div className="stat"><b>{p.body}</b><span className="muted small">pesos</span></div>
            </div>
          </div>
          <Seg value={mode} onChange={setMode} options={[['merge', 'Mesclar'], ['replace', 'Substituir tudo']]} />
          <p className="muted small">
            {mode === 'merge'
              ? 'Mesclar: adiciona o que falta; o que já existe no aparelho é mantido.'
              : 'Substituir: apaga os dados atuais e usa só o backup. Um snapshot de segurança é criado antes.'}
          </p>
          <button className={mode === 'replace' ? 'danger block' : 'primary block'} disabled={busy} onClick={() => doImport(mode)}>
            {mode === 'replace' ? 'Substituir tudo' : 'Mesclar'}
          </button>
        </Sheet>
      )}
    </>
  )
}
