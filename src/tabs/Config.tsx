import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { PromptTitle } from '../components/TerminalChrome'
import { Field, Seg, Sheet, useUi } from '../components/ui'
import {
  BackupError, createSnapshot, exportBackupToFile, importBackup, listSnapshots, parseBackup, previewBackup,
  restoreSnapshot, type ImportMode,
} from '../data/backup'
import { db, setSetting } from '../data/db'
import {
  authResetPassword,
  authSignIn,
  authSignInWithGoogle,
  authSignOut,
  triggerBackgroundSync,
} from '../data/sync'
import type { Backup } from '../data/types'
import { useSetting, useSyncStatus } from '../hooks'
import {
  DEFAULT_MAIN_NAV_TABS,
  getAllowedMainNavTabs,
  getMainNavTabsSettingKey,
  normalizeMainNavTabs,
  type MainNavTab,
} from '../lib/navigation'
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
import {
  THEME_OPTIONS,
  useTheme,
} from '../lib/theme'
import {
  cancelUserPushReminder,
  enablePushNotifications,
  fetchIfesWorkerStatus,
  formatKeywordsInput,
  formatPushReminderDateTime,
  getActiveVapidKeyPreview,
  getNotificationDiagnosticsLocal,
  getNotificationPermissionLabel,
  getSavedLocalFcmToken,
  isIosSafariNotInstalled,
  isStandalonePwa,
  loadUserFcmTokenDoc,
  parseKeywordsInput,
  recordLastNotificationError,
  subscribeUserPendingPushReminders,
  triggerPushTest,
  updateUserFcmSettings,
  type FcmTokenDoc,
  type IfesWorkerStatus,
  type PushReminderItem,
} from '../lib/notifications'

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
  const [theme, setTheme] = useTheme()
  const lastBackup = useSetting<number | null>('lastBackupAt', null)
  const lastSyncAt = useSetting<number | null>('lastSyncAt', null)
  const savedProfileName = useSetting<string>('profileName', '') ?? ''
  const [profileNameDraft, setProfileNameDraft] = useState<string>('')
  const pendingOutbox = useLiveQuery(() => db.outbox.count(), [], 0)
  const syncStatus = useSyncStatus()
  const mainNavTabsKey = getMainNavTabsSettingKey(syncStatus.user?.uid)
  const savedMainNavTabs = useSetting<unknown>(mainNavTabsKey, DEFAULT_MAIN_NAV_TABS)
  const [mainNavTabsDraft, setMainNavTabsDraft] = useState<MainNavTab[]>(DEFAULT_MAIN_NAV_TABS)
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

  // Estado de notificações push (Notícias do Ifes – Campus Vitória)
  const notifDiagLocal = useLiveQuery(
    () => getNotificationDiagnosticsLocal(),
    [],
    { lastNotificationAt: null, lastError: null },
  )
  const [fcmDoc, setFcmDoc] = useState<FcmTokenDoc | null>(null)
  const [keywordsText, setKeywordsText] = useState('')
  const [notifBusy, setNotifBusy] = useState(false)
  const [notifMsg, setNotifMsg] = useState('')
  const [notifErr, setNotifErr] = useState('')
  const [permissionLabel, setPermissionLabel] = useState(() => getNotificationPermissionLabel())
  const [standalonePwa, setStandalonePwa] = useState(() => isStandalonePwa())
  const [iosNotInstalled, setIosNotInstalled] = useState(() => isIosSafariNotInstalled())
  const [workerIfesStatus, setWorkerIfesStatus] = useState<IfesWorkerStatus | null>(null)
  const [pendingReminders, setPendingReminders] = useState<PushReminderItem[]>([])

  useEffect(() => {
    setMainNavTabsDraft(normalizeMainNavTabs(savedMainNavTabs, syncStatus.user?.uid))
  }, [mainNavTabsKey, savedMainNavTabs, syncStatus.user?.uid])

  const allowedMainNavTabs = getAllowedMainNavTabs(syncStatus.user?.uid)
  const toggleMainNavTab = (next: MainNavTab) => {
    setMainNavTabsDraft((current) =>
      current.includes(next)
        ? current.length > 1 ? current.filter((tab) => tab !== next) : current
        : current.length < 4 ? [...current, next] : current,
    )
  }
  const saveMainNavTabs = async () => {
    const normalized = normalizeMainNavTabs(mainNavTabsDraft, syncStatus.user?.uid)
    await setSetting(mainNavTabsKey, normalized)
    setMainNavTabsDraft(normalized)
    toast('Atalhos da navegação salvos')
  }

  useEffect(() => {
    if (!syncStatus.user?.uid) {
      setPendingReminders([])
      return
    }
    const unsub = subscribeUserPendingPushReminders(syncStatus.user.uid, (items) => {
      setPendingReminders(items)
    })
    return () => unsub()
  }, [syncStatus.user?.uid])

  const handleCancelPushReminder = async (rem: PushReminderItem) => {
    try {
      await cancelUserPushReminder(rem.id)
      toast(`Lembrete "${rem.title}" cancelado`)
    } catch (e) {
      toast((e as Error)?.message || 'Falha ao cancelar lembrete')
    }
  }

  useEffect(() => {
    setPermissionLabel(getNotificationPermissionLabel())
    setStandalonePwa(isStandalonePwa())
    setIosNotInstalled(isIosSafariNotInstalled())
    if (!syncStatus.user?.uid) {
      setFcmDoc(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const docSnap = await loadUserFcmTokenDoc(syncStatus.user!.uid)
      if (cancelled) return
      setFcmDoc(docSnap)
      if (docSnap) {
        setKeywordsText(formatKeywordsInput(docSnap.keywords))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [syncStatus.user?.uid])

  const handleEnableNotifications = async () => {
    setNotifErr('')
    setNotifMsg('')
    setNotifBusy(true)
    try {
      const saved = await enablePushNotifications(keywordsText)
      setPermissionLabel(getNotificationPermissionLabel())
      setFcmDoc(saved)
      setKeywordsText(formatKeywordsInput(saved.keywords))
      setNotifMsg('Token FCM registrado e notificações ativadas.')
      toast('Notificações ativadas')
    } catch (e) {
      setPermissionLabel(getNotificationPermissionLabel())
      const msg = (e as Error)?.message || 'error: falha ao ativar notificações.'
      setNotifErr(msg)
      await recordLastNotificationError(msg)
    } finally {
      setNotifBusy(false)
    }
  }

  const handleToggleFcmEnabled = async () => {
    if (!syncStatus.user) {
      setNotifErr('error: faça login primeiro.')
      return
    }
    if (!fcmDoc) {
      await handleEnableNotifications()
      return
    }
    setNotifErr('')
    setNotifMsg('')
    setNotifBusy(true)
    try {
      const nextEnabled = !fcmDoc.enabled
      const updated = await updateUserFcmSettings(syncStatus.user.uid, {
        enabled: nextEnabled,
      })
      if (updated) setFcmDoc(updated)
      toast(nextEnabled ? 'Notificações ligadas' : 'Notificações desligadas')
    } catch (e) {
      const msg = (e as Error)?.message || 'error: falha ao alterar estado das notificações.'
      setNotifErr(msg)
      await recordLastNotificationError(msg)
    } finally {
      setNotifBusy(false)
    }
  }

  const handleSaveKeywords = async () => {
    if (!syncStatus.user) {
      setNotifErr('error: faça login primeiro.')
      return
    }
    setNotifErr('')
    setNotifMsg('')
    setNotifBusy(true)
    try {
      const parsed = parseKeywordsInput(keywordsText)
      const updated = await updateUserFcmSettings(syncStatus.user.uid, {
        keywords: parsed,
      })
      if (updated) {
        setFcmDoc(updated)
        setKeywordsText(formatKeywordsInput(updated.keywords))
      }
      setNotifMsg(
        parsed.length > 0
          ? `Filtro salvo: ${parsed.join(', ')}`
          : 'Filtro limpo (você receberá todas as notícias do Campus Vitória).',
      )
      toast('Filtro de palavras-chave salvo')
    } catch (e) {
      const msg = (e as Error)?.message || 'error: falha ao salvar palavras-chave.'
      setNotifErr(msg)
      await recordLastNotificationError(msg)
    } finally {
      setNotifBusy(false)
    }
  }

  const handleSendPushTest = async () => {
    setNotifErr('')
    setNotifMsg('')
    setNotifBusy(true)
    try {
      const res = await triggerPushTest()
      if (res.totalTokens === 0) {
        const msg = res.message || 'Nenhum token ativo encontrado. Toque em "$ ativar notificações" primeiro.'
        setNotifErr(msg)
      } else {
        const summary = res.results
          .map((r) => `${r.tokenPreview}: ${r.ok ? 'OK' : `ERRO (${r.reason})`}`)
          .join(' · ')
        setNotifMsg(`Enviadas: ${res.sent}/${res.totalTokens} (${summary})`)
        toast(res.sent > 0 ? 'Notificação de teste enviada' : 'Falha no envio do teste')
      }
    } catch (e) {
      const msg = (e as Error)?.message || 'error: falha ao enviar notificação de teste.'
      setNotifErr(msg)
    } finally {
      setNotifBusy(false)
    }
  }

  const handleCheckIfesWorkerStatus = async () => {
    setNotifErr('')
    setNotifBusy(true)
    try {
      const st = await fetchIfesWorkerStatus()
      setWorkerIfesStatus(st)
    } catch (e) {
      const msg = (e as Error)?.message || 'error: falha ao consultar status do Worker.'
      setNotifErr(msg)
    } finally {
      setNotifBusy(false)
    }
  }

  useEffect(() => {
    setProfileNameDraft(savedProfileName)
  }, [savedProfileName])

  const saveProfileName = async () => {
    const clean = profileNameDraft.trim()
    await setSetting('profileName', clean)
    toast(clean ? `Saudação atualizada para "${clean}"` : 'Nome da saudação redefinido')
  }

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
    if (!(await confirm('Sair da conta atual?', 'sair', false))) return
    await authSignOut()
    toast('Sessão encerrada')
  }

  const doGoogleSignIn = async () => {
    setAuthErr('')
    setAuthBusy(true)
    try {
      const prevUid = syncStatus.user?.uid
      await authSignInWithGoogle()
      toast(prevUid ? 'Conta alternada com sucesso' : 'Sessão iniciada com Google')
    } catch (e) {
      const code = (e as { code?: string })?.code ?? ''
      if (!code.includes('popup-closed-by-user') && !code.includes('cancelled-popup-request')) {
        setAuthErr(authErrorMsg(e))
      }
    } finally {
      setAuthBusy(false)
    }
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

      <h2>aparência e tema</h2>
      <div className="card stack">
        <div className="row between">
          <span className="muted small">tema do aplicativo</span>
          <b className="green">{THEME_OPTIONS.find((t) => t.id === theme)?.label ?? theme}</b>
        </div>
        <div className="theme-grid" role="radiogroup" aria-label="Tema do aplicativo">
          {THEME_OPTIONS.map((opt) => {
            const active = theme === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`theme-card${active ? ' on' : ''}`}
                onClick={() => {
                  setTheme(opt.id)
                  toast(`Tema ${opt.label} ativado`)
                }}
              >
                <span className="theme-swatches" aria-hidden="true">
                  <span className="theme-swatch" style={{ background: opt.bgPreview }} />
                  <span className="theme-swatch" style={{ background: opt.accentPreview }} />
                </span>
                <b>{opt.label}</b>
                <span className="muted" style={{ fontSize: 10, lineHeight: 1.2 }}>
                  {opt.subtitle}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <h3>atalhos da navegação</h3>
      <div className="card stack">
        <div className="muted small">
          Escolha quatro abas. A esfera central do Assistente permanece fixa.
        </div>
        <div className="chips" role="group" aria-label="Atalhos da barra inferior">
          {allowedMainNavTabs.map((navTab) => {
            const checked = mainNavTabsDraft.includes(navTab)
            const label: Record<MainNavTab, string> = {
              hoje: 'Hoje',
              treino: 'Treino',
              dieta: 'Dieta',
              corpo: 'Corpo',
              noticias: 'Notícias',
              onibus: 'Ônibus',
              faculdade: 'Faculdade',
              gastos: 'Gastos',
              config: 'Configurações',
            }
            return (
              <button
                key={navTab}
                type="button"
                className={`small ${checked ? 'on' : 'ghost'}`}
                style={{ minHeight: 44 }}
                aria-pressed={checked}
                disabled={!checked && mainNavTabsDraft.length >= 4}
                onClick={() => toggleMainNavTab(navTab)}
              >
                {checked ? '✓ ' : ''}{label[navTab]}
              </button>
            )
          })}
        </div>
        <div className="row between">
          <span className="muted small">{mainNavTabsDraft.length}/4 selecionados</span>
          <button
            type="button"
            className="primary small"
            style={{ minHeight: 44 }}
            disabled={mainNavTabsDraft.length !== 4}
            onClick={() => void saveMainNavTabs()}
          >
            salvar atalhos
          </button>
        </div>
      </div>

      <h2>conta e sincronização</h2>
      {syncStatus.user ? (
        <div className="card stack">
          <div className="row between" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10 }}>
              {syncStatus.user.photoURL ? (
                <img
                  src={syncStatus.user.photoURL}
                  alt=""
                  referrerPolicy="no-referrer"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 999,
                    border: '1px solid var(--green)',
                    objectFit: 'cover',
                  }}
                />
              ) : (
                <span
                  className="bus-badge"
                  style={{ width: 36, height: 36, borderRadius: 999, padding: 0 }}
                >
                  {(syncStatus.user.displayName || syncStatus.user.email || 'U')
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
              )}
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  {syncStatus.user.displayName || syncStatus.user.email || 'Conta conectada'}
                </div>
                <div className="muted small">
                  {syncStatus.user.email ?? syncStatus.user.uid}
                </div>
              </div>
            </div>
            <span className="chip" title={syncStatus.user.uid}>
              uid: {syncStatus.user.uid.slice(0, 6)}…
            </span>
          </div>
          <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
            <div className="grow">
              <Field
                label="nome na saudação"
                type="text"
                mode="text"
                value={profileNameDraft}
                onChange={setProfileNameDraft}
                placeholder="Ex.: Ian, Ana, Carlos…"
              />
            </div>
            <button
              type="button"
              className="small"
              style={{ minHeight: 44 }}
              disabled={profileNameDraft.trim() === savedProfileName.trim()}
              onClick={() => void saveProfileName()}
            >
              salvar nome
            </button>
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
          <button
            className="primary block"
            disabled={syncStatus.syncing}
            onClick={() => void doSyncNow()}
          >
            {syncStatus.syncing ? 'sincronizando…' : 'sincronizar agora'}
          </button>
          <div className="grid2">
            <button
              className="ai"
              disabled={authBusy}
              onClick={() => void doGoogleSignIn()}
            >
              {authBusy ? 'aguarde…' : 'trocar conta Google'}
            </button>
            <button onClick={() => void doSignOut()}>sair</button>
          </div>
        </div>
      ) : (
        <div className="card stack">
          <button
            className="ai block"
            disabled={authBusy}
            onClick={() => void doGoogleSignIn()}
          >
            {authBusy ? 'conectando…' : 'entrar com Google'}
          </button>
          <Seg
            value={authMode}
            onChange={(v) => { setAuthMode(v); setAuthErr('') }}
            options={[['login', 'e-mail e senha'], ['reset', 'redefinir senha']]}
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
                ? 'entrar com e-mail'
                : 'enviar link de redefinição'}
          </button>
          {pendingOutbox > 0 && (
            <p className="muted small" style={{ margin: 0 }}>
              Fila local: {pendingOutbox} pendente(s).
            </p>
          )}
        </div>
      )}

      <h2>segurança</h2>
      <div className="card stack">
        <div className="row between">
          <div className="grow">
            Face ID / WebAuthn
            <div className="muted small">
              {lockConfig?.enabled ? 'ativo' : 'desativado'}
            </div>
          </div>
          <button
            className={lockConfig?.enabled ? '' : 'primary'}
            onClick={() => void handleToggleLock()}
          >
            {lockConfig?.enabled ? 'desativar' : 'ativar'}
          </button>
        </div>

        <div className="row between small">
          <span className="muted">credencial</span>
          <b className={lockConfig?.credentialId ? 'green' : 'amber'}>
            {lockConfig?.credentialId
              ? `${lockConfig.credentialId.slice(0, 8)}…`
              : 'ausente'}
          </b>
        </div>
        <div className="row between small">
          <span className="muted">timeout</span>
          <b>{formatTimeoutLabel(lockConfig?.timeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES)}</b>
        </div>

        {lockErr && <div className="lock-err">{lockErr}</div>}

        <div className="stack">
          <div className="row between">
            <div className="grow">bloquear após (min)</div>
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
              [0, 'sempre (0s)'],
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
      </div>

      <h2>notificações</h2>
      <div className="card stack">
        {iosNotInstalled && (
          <div className="banner" style={{ cursor: 'default', marginBottom: 4 }}>
            no iPhone, instale o app na tela de início para receber notificações
          </div>
        )}

        <div className="row between">
          <div className="grow">
            notícias do Ifes · Campus Vitória
            <div className="muted small">
              {fcmDoc
                ? fcmDoc.enabled
                  ? 'ativas neste aparelho (Web Push / FCM)'
                  : 'pausadas (desligadas)'
                : 'não ativadas neste aparelho'}
            </div>
          </div>
          <button
            className={fcmDoc?.enabled ? '' : 'primary'}
            disabled={notifBusy}
            onClick={() => void handleToggleFcmEnabled()}
          >
            {fcmDoc ? (fcmDoc.enabled ? 'desligar' : 'ligar') : 'ligar'}
          </button>
        </div>

        <button
          className="primary block"
          disabled={notifBusy}
          onClick={() => void handleEnableNotifications()}
        >
          {notifBusy ? 'aguarde…' : 'ativar notificações'}
        </button>

        <Field
          label="palavras-chave (separadas por vírgula; vazio = tudo)"
          type="text"
          mode="text"
          value={keywordsText}
          onChange={setKeywordsText}
          placeholder="ex.: edital, bolsa, estágio, mestrado"
        />
        <div className="grid2">
          <button
            className="small"
            disabled={notifBusy || !fcmDoc}
            onClick={() => void handleSaveKeywords()}
          >
            salvar filtro
          </button>
          <button
            className="small"
            disabled={notifBusy || !syncStatus.user}
            onClick={() => void handleSendPushTest()}
          >
            enviar notificação de teste
          </button>
        </div>

        {notifMsg && <div className="small green">{notifMsg}</div>}
        {notifErr && <div className="small red">{notifErr}</div>}

        <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
          <div className="muted small"><b>diagnóstico de push</b></div>
          <div className="row between small">
            <span className="muted">permissão</span>
            <b
              className={
                permissionLabel === 'concedida'
                  ? 'green'
                  : permissionLabel === 'negada'
                    ? 'red'
                    : 'amber'
              }
            >
              {permissionLabel}
            </b>
          </div>
          <div className="row between small">
            <span className="muted">instalado como PWA (standalone)</span>
            <b className={standalonePwa ? 'green' : 'amber'}>
              {standalonePwa ? 'sim (display-mode: standalone)' : 'não (navegador)'}
            </b>
          </div>
          <div className="row between small">
            <span className="muted">token registrado</span>
            <b className={fcmDoc || getSavedLocalFcmToken() ? 'green' : 'amber'}>
              {fcmDoc
                ? `sim (${fcmDoc.token.slice(0, 12)}…)`
                : getSavedLocalFcmToken()
                  ? `local (${getSavedLocalFcmToken()!.slice(0, 12)}…)`
                  : 'não'}
            </b>
          </div>
          <div className="row between small">
            <span className="muted">chave VAPID ativa no app</span>
            <b>{getActiveVapidKeyPreview()}</b>
          </div>
          <div className="row between small">
            <span className="muted">última notificação recebida</span>
            <b>
              {notifDiagLocal.lastNotificationAt
                ? fmtDateTime(notifDiagLocal.lastNotificationAt)
                : 'nenhuma ainda'}
            </b>
          </div>
          <div className="row between small">
            <span className="muted">último erro</span>
            <b className={notifDiagLocal.lastError || notifErr ? 'red' : 'muted'}>
              {notifErr || notifDiagLocal.lastError || 'nenhum'}
            </b>
          </div>

          {workerIfesStatus && (
            <>
              <div className="row between small">
                <span className="muted">última coleta do Worker</span>
                <b>{workerIfesStatus.lastRunAt ? fmtDateTime(workerIfesStatus.lastRunAt) : 'nunca'}</b>
              </div>
              <div className="row between small">
                <span className="muted">notícias no Firestore</span>
                <b>{workerIfesStatus.totalNoticias}</b>
              </div>
              {(workerIfesStatus.alert || workerIfesStatus.lastError) && (
                <div className="small red">
                  {workerIfesStatus.alert ?? workerIfesStatus.lastError}
                </div>
              )}
            </>
          )}

          {syncStatus.user && (
            <button
              className="small ghost"
              disabled={notifBusy}
              onClick={() => void handleCheckIfesWorkerStatus()}
            >
              consultar status do coletor (/ifes/status)
            </button>
          )}
        </div>

        <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
          <div className="row between">
            <span className="muted small"><b>lembretes push agendados</b></span>
            <span className="chip">{pendingReminders.length} pendente(s)</span>
          </div>
          {!syncStatus.user ? (
            <div className="muted small">Faça login para ver seus lembretes push agendados.</div>
          ) : pendingReminders.length === 0 ? (
            <div className="muted small">
              Nenhum lembrete push pendente. Peça no <b>Assistente</b> (ex.: "me lembra às 18h de tomar creatina").
            </div>
          ) : (
            pendingReminders.map((rem) => (
              <div key={rem.id} className="item">
                <div className="grow">
                  <div>
                    <b>{rem.title}</b>{' '}
                    {rem.recurrence !== 'none' && (
                      <span className="chip">
                        {rem.recurrence === 'daily' ? 'diário' : 'semanal'}
                      </span>
                    )}
                  </div>
                  <div className="muted small">
                    {formatPushReminderDateTime(rem.triggerAt)}
                    {rem.body ? ` · ${rem.body}` : ''}
                  </div>
                </div>
                <button
                  className="small danger"
                  onClick={() => void handleCancelPushReminder(rem)}
                >
                  cancelar
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <h2>backup</h2>
      <div className="card stack" style={{ borderColor: backupAge === null || backupAge > 7 ? 'var(--amber)' : 'var(--green)' }}>
        <div className="muted small">último backup exportado</div>
        <div className={backupAge === null || backupAge > 7 ? 'big amber' : 'big green'}>{lastBackup ? fmtDateTime(lastBackup) : 'nunca'}</div>
        {backupAge !== null && <div className="muted small">há {backupAge} dia(s)</div>}
        <button className="primary block" disabled={busy} onClick={doExport}>exportar backup (json)</button>
        <button className="block" disabled={busy} onClick={() => fileRef.current?.click()}>importar backup…</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        {error && <div style={{ color: 'var(--red)' }}>{error}</div>}
      </div>

      <h2>armazenamento</h2>
      <div className="card stack">
        <div className="row between"><span>Persistente</span><b style={{ color: persisted ? 'var(--green)' : 'var(--amber)' }}>{persisted === null ? '…' : persisted ? 'Sim' : 'Não'}</b></div>
        <div className="row between"><span>Em uso</span><b>{mb(usage.used)}</b></div>
        <div className="row between"><span>Cota</span><b>{mb(usage.quota)}</b></div>
        {persisted === false && <button className="block" onClick={requestPersist}>Ativar persistência</button>}
      </div>

      <h2>snapshots</h2>
      <div className="card">
        <button className="small block" onClick={async () => { await createSnapshot('manual', 'Manual'); toast('Snapshot criado') }}>Criar snapshot</button>
        {snaps.length === 0 && <p className="muted small">Nenhum snapshot.</p>}
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
          <div className="grow">tolerância do streak (dias)</div>
          <button aria-label="menos" onClick={() => setSetting('streakGap', Math.max(0, gap - 1))}>-</button>
          <b style={{ width: 24, textAlign: 'center' }}>{gap}</b>
          <button aria-label="mais" onClick={() => setSetting('streakGap', Math.min(7, gap + 1))}>+</button>
        </div>
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: 20 }}>
        Meu Treino · {syncStatus.user ? 'sincronizado' : 'local'}
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
              {lockBusy ? 'aguardando Face ID…' : 'registrar Face ID e ativar'}
            </button>
          </div>
        </Sheet>
      )}
    </>
  )
}
