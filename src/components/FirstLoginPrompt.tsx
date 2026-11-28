import { useState } from 'react'
import { authSignOut, getSyncStatus, resolveFirstLoginChoice, type FirstLoginPreview } from '../data/sync'
import { Field, Sheet, useUi } from './ui'

export default function FirstLoginPrompt({
  preview,
  syncing,
}: {
  preview: FirstLoginPreview
  syncing: boolean
}) {
  const { toast } = useUi()
  const { local, cloud, needsProfileName, existingProfileName } = preview
  const currentUser = getSyncStatus().user

  const defaultName =
    existingProfileName ||
    currentUser?.displayName?.trim().split(/\s+/)[0] ||
    ''
  const [profileName, setProfileName] = useState<string>(defaultName)
  const [nameErr, setNameErr] = useState<string>('')

  const hasLocalConflict = local.totalUserItems > 0
  const askName = needsProfileName !== false

  const handle = async (sendLocal: boolean) => {
    const clean = profileName.trim()
    if (askName && !clean) {
      setNameErr('Informe como prefere ser chamado(a) na saudação.')
      return
    }
    setNameErr('')
    await resolveFirstLoginChoice(sendLocal, clean || undefined)
    toast(
      hasLocalConflict
        ? sendLocal
          ? 'Dados sincronizados e mesclados'
          : 'Dados da nuvem carregados neste aparelho'
        : `Bem-vindo(a), ${clean || 'Atleta'}`,
    )
  }

  return (
    <Sheet
      title={hasLocalConflict ? 'Primeiro login neste aparelho' : 'Boas-vindas'}
      onClose={() => {}}
    >
      <div className="stack">
        {askName && (
          <div className="card stack" style={{ marginBottom: 4 }}>
            <Field
              label="Como quer ser chamado(a) na saudação?"
              type="text"
              mode="text"
              value={profileName}
              onChange={(v) => {
                setProfileName(v)
                if (nameErr) setNameErr('')
              }}
              placeholder="Ex.: Ian, Ana, Carlos…"
            />
            {nameErr && <div className="small red">{nameErr}</div>}
          </div>
        )}

        {hasLocalConflict ? (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Este aparelho possui dados locais. Escolha como sincronizar com sua conta (um
              snapshot de segurança local será criado antes).
            </p>

            <div className="grid2">
              <div className="card">
                <div className="muted small">Neste aparelho</div>
                <div className="stack" style={{ marginTop: 6 }}>
                  <div>
                    <b>{local.sessions}</b> <span className="muted small">treinos</span>
                  </div>
                  <div>
                    <b>{local.meals}</b> <span className="muted small">refeições</span>
                  </div>
                  <div>
                    <b>{local.body}</b> <span className="muted small">pesos</span>
                  </div>
                  <div>
                    <b>{local.routines}</b> <span className="muted small">rotinas</span>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="muted small">Na nuvem</div>
                <div className="stack" style={{ marginTop: 6 }}>
                  <div>
                    <b>{cloud.sessions}</b> <span className="muted small">treinos</span>
                  </div>
                  <div>
                    <b>{cloud.meals}</b> <span className="muted small">refeições</span>
                  </div>
                  <div>
                    <b>{cloud.body}</b> <span className="muted small">pesos</span>
                  </div>
                  <div>
                    <b>{cloud.routines}</b> <span className="muted small">rotinas</span>
                  </div>
                </div>
              </div>
            </div>

            <button className="primary block" disabled={syncing} onClick={() => void handle(true)}>
              Mesclar dados locais com a nuvem
            </button>
            <button className="block" disabled={syncing} onClick={() => void handle(false)}>
              Usar apenas dados da nuvem
            </button>
          </>
        ) : (
          <button className="primary block" disabled={syncing} onClick={() => void handle(true)}>
            {syncing ? 'Sincronizando…' : 'Salvar e continuar'}
          </button>
        )}

        <button className="ghost small block" disabled={syncing} onClick={() => void authSignOut()}>
          Sair da conta
        </button>
      </div>
    </Sheet>
  )
}
