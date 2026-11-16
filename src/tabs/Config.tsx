import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { PromptTitle } from '../components/TerminalChrome'
import { Field, Seg, Sheet, useUi } from '../components/ui'
import {
  BackupError, createSnapshot, exportBackupToFile, importBackup, listSnapshots, parseBackup, previewBackup,
  restoreSnapshot, type ImportMode,
} from '../data/backup'
import { db, setSetting } from '../data/db'
import { authResetPassword, authSignIn, authSignOut, triggerBackgroundSync } from '../data/sync'
import type { Backup } from '../data/types'
import { useSetting, useSyncStatus } from '../hooks'
import {
  DEFAULT_LOCK_TIMEOUT_MINUTES,
  disableLock,
  formatTimeoutLabel,
  getLockConfig,
  isPlatformWebAuthnSupported,
  isValidPin,
  registerBiometricCredential,
  saveLockSetup,
  setLockTimeoutMinutes,
} from '../lib/lock'

const fmtDateTime = (t: number | string) => new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const mb = (n?: number) => (n === undefined ? '—' : `${(n / 1024 / 1024).toFixed(2)} MB`)
const KIND: Record<string, string> = { auto: 'Automático', seguranca: 'Segurança', manual: 'Manual' }

function authErrorMsg(err: unknown): string {
  const code = (err as { code?: string })?.code ?? ''
  if (code.includes('invalid-email')) return 'E-mail inválido.'
  if (code.includes('user-not-found') || code.includes('invalid-credential') || code.includes('wrong-password')) return 'E-mail ou senha incorretos.'
  if (code.includes('email-already-in-use')) return 'Este e-mail já está cadastrado.'
  if (code.includes('weak-password')) return 'A senha precisa ter pelo menos 6 caracteres.'
  if (code.includes('network-request-failed')) return 'Sem conexão com a internet.'
  if (code.includes('too-many-requests')) return 'Muitas tentativas. Aguarde alguns minutos.'
  return 'Não foi possível concluir a operação. Verifique a conexão e tente novamente.'
}

export default function Config() {
  const { toast, confirm } = useUi()
  const lastBackup = useSetting<number | null>('lastBackupAt', null)
  const lastSyncAt = useSetting<number | null>('lastSyncAt', null)
  const pendingOutbox = useLiveQuery(() => db.outbox.count(), [], 0)
  const syncStatus = useSyncStatus()
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<{ used?: number; quota?: number }>({})
  const [pending, setPending] = useState<Backup | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const snaps = useLiveQuery(() => listSnapshots(), [], [])

  // Estado de formulário Auth (criação de conta desativada na UI)
  const [authMode, setAuthMode] = useState<'login' | 'reset'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authErr, setAuthErr] = useState('')

  // Estado de tranca por Face ID + PIN reserva
  const lockConfig = useLiveQuery(() => getLockConfig(), [])
  const [setupOpen, setSetupOpen] = useState(false)
  const [pin1, setPin1] = useState('')
  const [pin2, setPin2] = useState('')
  const [lockBusy, setLockBusy] = useState(false)
  const [lockErr, setLockErr] = useState('')

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

  const submitAuth = async () => {
    setAuthErr('')
    if (!email.trim()) return setAuthErr('Informe seu e-mail.')
    if (authMode !== 'reset' && password.length < 6) return setAuthErr('A senha deve ter pelo menos 6 caracteres.')
    setAuthBusy(true)
    try {
      if (authMode === 'login') {
        await authSignIn(email, password)
        setPassword('')
        toast('Sessão iniciada')
      } else {
        await authResetPassword(email)
        toast('E-mail de redefinição enviado')
        setAuthMode('login')
      }
    } catch (e) {
      setAuthErr(authErrorMsg(e))
    } finally {
      setAuthBusy(false)
    }
  }

  const openLockSetup = () => {
    setPin1('')
    setPin2('')
    setLockErr('')
    setSetupOpen(true)
  }

  const confirmEnableLock = async () => {
    setLockErr('')
    if (!isValidPin(pin1)) {
      setLockErr('error: o PIN reserva deve ter de 4 a 6 dígitos numéricos.')
      return
    }
    if (pin1 !== pin2) {
      setLockErr('error: os PINs informados não conferem.')
      return
    }
    if (!isPlatformWebAuthnSupported()) {
      setLockErr('error: WebAuthn / Face ID indisponível neste navegador.')
      return
    }
    setLockBusy(true)
    try {
      // Chamada direta a partir do toque do usuário (exigência do iOS).
      // Padrão ao ativar: DEFAULT_LOCK_TIMEOUT_MINUTES = 0 ("sempre ao abrir").
      const credId = await registerBiometricCredential()
      const initialTimeout = lockConfig?.timeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES
      await saveLockSetup(credId, pin1, initialTimeout)
      setSetupOpen(false)
      setPin1('')
      setPin2('')
      setLockErr('')
      toast('Bloqueio com Face ID ativado')
    } catch (e) {
      const msg = (e as Error)?.message || 'falha ao registrar Face ID.'
      const formatted = msg.startsWith('error:') ? msg : `error: ${msg}`
      setLockErr(formatted)
    } finally {
      setLockBusy(false)
    }
  }

  const handleToggleLock = async () => {
    if (lockConfig?.enabled) {
      if (!(await confirm('Desativar o bloqueio com Face ID e remover o PIN reserva deste aparelho?', 'desativar', false))) return
      await disableLock()
      toast('Bloqueio com Face ID desativado')
    } else {
      openLockSetup()
    }
  }

  const doSignOut = async () => {
    if (!(await confirm('Sair da conta? Os dados locais continuam salvos neste aparelho.', 'sair', false))) return
    await authSignOut()
    toast('Você saiu da conta (modo local ativo)')
  }

  const doSyncNow = async () => {
    await triggerBackgroundSync(false)
    toast('Sincronização concluída')
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
      <PromptTitle path="~/config" />

      <h2>sincronização em nuvem</h2>
      {syncStatus.user ? (
        <div className="card stack">
          <div className="row between">
            <span className="muted small">logado como</span>
            <b className="green">{syncStatus.user.email ?? syncStatus.user.uid}</b>
          </div>
          <div className="row between">
            <span className="muted small">última sincronização</span>
            <b>{lastSyncAt ? fmtDateTime(lastSyncAt) : 'nunca'}</b>
          </div>
          <div className="row between">
            <span className="muted small">itens pendentes</span>
            <b className={pendingOutbox > 0 ? 'amber' : ''}>{pendingOutbox}</b>
          </div>
          {syncStatus.error && <div className="small red">{syncStatus.error}</div>}
          <div className="grid2">
            <button className="primary" disabled={syncStatus.syncing} onClick={() => void doSyncNow()}>
              {syncStatus.syncing ? 'sincronizando…' : '$ sincronizar agora'}
            </button>
            <button onClick={() => void doSignOut()}>sair</button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Sair não apaga os dados locais deste aparelho.
          </p>
        </div>
      ) : (
        <div className="card stack">
          <Seg
            value={authMode}
            onChange={(v) => { setAuthMode(v); setAuthErr('') }}
            options={[['login', 'entrar'], ['reset', 'redefinir senha']]}
          />
          <Field label="e-mail" type="email" mode="text" value={email} onChange={setEmail} placeholder="voce@exemplo.com" />
          {authMode !== 'reset' && (
            <Field label="senha" type="password" mode="text" value={password} onChange={setPassword} placeholder="mín. 6 caracteres" />
          )}
          {authErr && <div className="small red">{authErr}</div>}
          <button className="primary block" disabled={authBusy} onClick={() => void submitAuth()}>
            {authBusy
              ? 'aguarde…'
              : authMode === 'login'
                ? '$ entrar'
                : '$ enviar link de redefinição'}
          </button>
          <p className="muted small" style={{ margin: 0 }}>
            Modo offline-first: você pode usar o app sem conta; entre quando quiser sincronizar com a nuvem ({pendingOutbox} pendente(s) na fila local).
          </p>
        </div>
      )}

      <h2>segurança</h2>
      <div className="card stack">
        <div className="row between">
          <div className="grow">
            bloquear com Face ID
            <div className="muted small">
              {lockConfig?.enabled ? 'ativo neste aparelho (WebAuthn + PIN)' : 'desativado'}
            </div>
          </div>
          <button
            className={lockConfig?.enabled ? '' : 'primary'}
            onClick={() => void handleToggleLock()}
          >
            {lockConfig?.enabled ? 'desativar' : '$ ativar'}
          </button>
        </div>

        <div className="row between small">
          <span className="muted">estado da tranca</span>
          <b className={lockConfig?.enabled ? 'green' : 'muted'}>
            {lockConfig?.enabled ? 'ativada' : 'desativada'}
          </b>
        </div>
        <div className="row between small">
          <span className="muted">credencial WebAuthn</span>
          <b className={lockConfig?.credentialId ? 'green' : 'amber'}>
            {lockConfig?.credentialId
              ? `cadastrada (${lockConfig.credentialId.slice(0, 8)}…)`
              : 'não cadastrada'}
          </b>
        </div>
        <div className="row between small">
          <span className="muted">tempo configurado</span>
          <b>{formatTimeoutLabel(lockConfig?.timeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES)}</b>
        </div>

        {lockErr && <div className="lock-err">{lockErr}</div>}

        <div className="stack">
          <div className="row between">
            <div className="grow">
              bloquear após segundo plano
              <div className="muted small">0 = sempre ao abrir · ou após N minutos</div>
            </div>
            <button
              aria-label="menos minutos"
              onClick={() => void setLockTimeoutMinutes(Math.max(0, (lockConfig?.timeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES) - 1))}
            >
              -
            </button>
            <b style={{ width: 28, textAlign: 'center' }}>
              {lockConfig?.timeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES}
            </b>
            <button
              aria-label="mais minutos"
              onClick={() => void setLockTimeoutMinutes(Math.min(60, (lockConfig?.timeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES) + 1))}
            >
              +
            </button>
          </div>
          <div className="row wrap">
            {[
              [0, 'sempre ao abrir (0s)'],
              [1, '1 min'],
              [5, '5 min'],
              [15, '15 min'],
            ].map(([mins, label]) => {
              const cur = lockConfig?.timeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES
              return (
                <button
                  key={mins}
                  className={`small ${cur === mins ? 'on' : ''}`}
                  onClick={() => void setLockTimeoutMinutes(Number(mins))}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          A credencial biométrica e o hash do PIN ficam apenas neste aparelho (não vão para o Firestore nem para o backup).
        </p>
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

      <h2>armazenamento</h2>
      <div className="card stack">
        <div className="row between"><span>Armazenamento persistente</span><b style={{ color: persisted ? 'var(--green)' : 'var(--amber)' }}>{persisted === null ? '…' : persisted ? 'Sim' : 'Não'}</b></div>
        <div className="row between"><span>Em uso</span><b>{mb(usage.used)}</b></div>
        <div className="row between"><span>Cota estimada</span><b>{mb(usage.quota)}</b></div>
        {persisted === false && <button className="block" onClick={requestPersist}>Pedir armazenamento persistente</button>}
        <p className="muted small" style={{ margin: 0 }}>Mesmo persistente e com nuvem, exporte backups em JSON periodicamente.</p>
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

      <h2>privacidade (assistente de ia)</h2>
      <div className="card stack">
        <p className="muted small" style={{ margin: 0 }}>
          Ao conversar na aba <b>~/assistente</b>, suas mensagens e apenas os resumos necessários dos seus dados locais (como treinos recentes, dieta do período ou peso, listados abaixo de cada resposta) são transmitidos via HTTPS pelo seu proxy no <b>Cloudflare Workers</b> e processados pela API do <b>Groq</b> para gerar a resposta.
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          O banco completo nunca é enviado, o histórico do chat fica salvo somente neste aparelho (fora do backup e do Firestore) e nenhuma escrita sugerida pela IA é gravada sem o seu toque explícito em confirmar.
        </p>
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: 20 }}>
        Meu Treino · offline-first · {syncStatus.user ? 'sincronizado' : 'modo local'}
      </p>

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

      {setupOpen && (
        <Sheet title="ativar bloqueio com Face ID" onClose={() => !lockBusy && setSetupOpen(false)}>
          <div className="stack">
            <p className="muted small" style={{ marginTop: 0 }}>
              Defina um PIN numérico de 4 a 6 dígitos como reserva caso o Face ID falhe. Apenas o hash PBKDF2 com salt é salvo localmente.
            </p>
            <Field
              label="PIN reserva (4 a 6 dígitos)"
              type="password"
              mode="numeric"
              value={pin1}
              onChange={(v) => setPin1(v.replace(/\D/g, '').slice(0, 6))}
              placeholder="••••"
            />
            <Field
              label="confirmar PIN reserva"
              type="password"
              mode="numeric"
              value={pin2}
              onChange={(v) => setPin2(v.replace(/\D/g, '').slice(0, 6))}
              placeholder="••••"
            />
            {lockErr && <div className="lock-error">{lockErr}</div>}
            <button
              className="primary block"
              disabled={lockBusy}
              onClick={() => void confirmEnableLock()}
            >
              {lockBusy ? 'aguardando Face ID…' : '$ registrar Face ID e ativar'}
            </button>
          </div>
        </Sheet>
      )}
    </>
  )
}
