import { useEffect, useRef, useState } from 'react'

// Beep curto via WebAudio. O contexto precisa ser criado/retomado num gesto do usuário (regra do iOS).
let audioCtx: AudioContext | null = null
export function primeAudio() {
  try {
    const AC = window.AudioContext ?? (window as any).webkitAudioContext
    if (!audioCtx && AC) audioCtx = new AC()
    void audioCtx?.resume()
  } catch { /* sem áudio */ }
}
function beep() {
  if (!audioCtx) return
  for (let i = 0; i < 2; i++) {
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.frequency.value = 660
    g.gain.value = 0.12
    o.connect(g).connect(audioCtx.destination)
    const t = audioCtx.currentTime + i * 0.2
    o.start(t)
    o.stop(t + 0.1)
  }
}

/** Descanso: contagem regressiva grande e silenciosa. Baseada no horário final (correta mesmo se a tela apagar). */
export default function RestPanel({ endAt, total, onChange, onClear }: { endAt: number; total: number; onChange: (end: number) => void; onClear: () => void }) {
  const [now, setNow] = useState(Date.now())
  const fired = useRef(false)
  useEffect(() => {
    fired.current = false
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [endAt])
  const leftMs = Math.max(0, endAt - now)
  const left = Math.ceil(leftMs / 1000)
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true
      navigator.vibrate?.([200, 100, 200]) // o iOS Safari costuma ignorar
      beep()
    }
  }, [left])
  const pct = total > 0 ? Math.min(100, ((total * 1000 - leftMs) / (total * 1000)) * 100) : 100
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted small">{left === 0 ? '# descanso concluído' : '# descanso'}</div>
      <div className={`rest-big ${left === 0 ? 'green' : ''}`}>{mm}:{ss}</div>
      <div className="bar" style={{ margin: '12px 0' }}><i style={{ width: `${pct}%`, transition: 'none' }} /></div>
      <div className="grid3">
        <button style={{ minHeight: 48 }} onClick={() => onChange(Math.max(Date.now(), endAt - 15000))}>-15s</button>
        <button style={{ minHeight: 48 }} onClick={() => onChange(endAt + 15000)}>+15s</button>
        <button style={{ minHeight: 48 }} onClick={onClear}>pular</button>
      </div>
    </div>
  )
}
