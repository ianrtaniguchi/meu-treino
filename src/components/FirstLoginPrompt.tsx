import { authSignOut, resolveFirstLoginChoice, type FirstLoginPreview } from '../data/sync'
import { Sheet, useUi } from './ui'

export default function FirstLoginPrompt({ preview, syncing }: { preview: FirstLoginPreview; syncing: boolean }) {
  const { toast } = useUi()
  const { local, cloud } = preview

  const handle = async (sendLocal: boolean) => {
    await resolveFirstLoginChoice(sendLocal)
    toast(sendLocal ? 'Dados locais enviados e mesclados com a nuvem' : 'Dados da nuvem carregados neste aparelho')
  }

  return (
    <Sheet title="primeiro login neste aparelho" onClose={() => {}}>
      <div className="stack">
        <p className="muted small" style={{ marginTop: 0 }}>
          Este aparelho já possui dados locais. Antes de sincronizar, revise a prévia abaixo e escolha como prosseguir (um snapshot de segurança local será criado automaticamente antes).
        </p>

        <div className="grid2">
          <div className="card">
            <div className="muted small">neste aparelho</div>
            <div className="stack" style={{ marginTop: 6 }}>
              <div><b>{local.sessions}</b> <span className="muted small">treinos</span></div>
              <div><b>{local.meals}</b> <span className="muted small">refeições</span></div>
              <div><b>{local.body}</b> <span className="muted small">pesos</span></div>
              <div><b>{local.routines}</b> <span className="muted small">rotinas</span></div>
            </div>
          </div>

          <div className="card">
            <div className="muted small">na nuvem</div>
            <div className="stack" style={{ marginTop: 6 }}>
              <div><b>{cloud.sessions}</b> <span className="muted small">treinos</span></div>
              <div><b>{cloud.meals}</b> <span className="muted small">refeições</span></div>
              <div><b>{cloud.body}</b> <span className="muted small">pesos</span></div>
              <div><b>{cloud.routines}</b> <span className="muted small">rotinas</span></div>
            </div>
          </div>
        </div>

        <button className="primary block" disabled={syncing} onClick={() => void handle(true)}>
          enviar dados locais para a nuvem (mesclar)
        </button>
        <button className="block" disabled={syncing} onClick={() => void handle(false)}>
          usar apenas dados da nuvem neste aparelho
        </button>
        <button className="ghost small block" disabled={syncing} onClick={() => void authSignOut()}>
          cancelar e sair da conta
        </button>
      </div>
    </Sheet>
  )
}
