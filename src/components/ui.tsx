import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

// ---------- Toast (com "Desfazer") e confirmação ----------
interface ToastState { msg: string; action?: { label: string; run: () => void } }
interface ConfirmState { msg: string; okLabel: string; danger: boolean; resolve: (v: boolean) => void }
interface Ui {
  toast: (msg: string, action?: ToastState['action'], ms?: number) => void
  confirm: (msg: string, okLabel?: string, danger?: boolean) => Promise<boolean>
}
const Ctx = createContext<Ui>(null as unknown as Ui)
export const useUi = () => useContext(Ctx)

export function UiProvider({ children }: { children: ReactNode }) {
  const [toastS, setToast] = useState<ToastState | null>(null)
  const [conf, setConf] = useState<ConfirmState | null>(null)
  const timer = useRef<number>()

  const toast = useCallback<Ui['toast']>((msg, action, ms = 6000) => {
    setToast({ msg, action })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), ms)
  }, [])
  const confirm = useCallback<Ui['confirm']>(
    (msg, okLabel = 'Excluir', danger = true) => new Promise((resolve) => setConf({ msg, okLabel, danger, resolve })),
    [],
  )
  const close = (v: boolean) => {
    conf?.resolve(v)
    setConf(null)
  }

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      {toastS && (
        <div className="toast" role="status">
          <span className="grow">{toastS.msg}</span>
          {toastS.action && (
            <button
              className="primary small"
              onClick={() => {
                toastS.action!.run()
                setToast(null)
              }}
            >
              {toastS.action.label}
            </button>
          )}
        </div>
      )}
      {conf && (
        <div className="overlay" style={{ zIndex: 90, alignItems: 'center' }}>
          <div className="sheet center stack" style={{ padding: 18 }}>
            <div>{conf.msg}</div>
            <div className="grid2">
              <button onClick={() => close(false)}>Cancelar</button>
              <button className={conf.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
                {conf.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}

// ---------- Componentes básicos ----------
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label={title}>
        <div className="sheet-head">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="ghost" onClick={onClose}>Fechar</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className={`bar ${value > max * 1.05 ? 'over' : ''}`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([k, label]) => (
        <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, value, onChange, mode = 'decimal', placeholder, type }: {
  label: string; value: string; onChange: (v: string) => void; mode?: 'decimal' | 'numeric' | 'text'; placeholder?: string; type?: string
}) {
  return (
    <label className="f">
      {label}
      <input value={value} type={type} inputMode={mode} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
