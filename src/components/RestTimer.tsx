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
  for (let i = 0; i < 3; i++) {
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.frequency.value = 880
    g.gain.value = 0.2
    o.connect(g).connect(audioCtx.destination)
    const t = audioCtx.currentTime + i * 0.25
    o.start(t)
    o.stop(t + 0.15)
  }
}

/** Timer de descanso baseado no horário final (continua correto se a tela apagar). */
export default function RestTimer({ endAt, onChange, onClear }: { endAt: number; onChange: (end: number) => void; onClear: () => void }) {
  const [now, setNow] = useState(Date.now())
  const fired = useRef(false)
  useEffect(() => {
    fired.current = false
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [endAt])
  const left = Math.max(0, Math.ceil((endAt - now) / 1000))
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true
      navigator.vibrate?.([300, 150, 300]) // iOS Safari geralmente não suporta vibração
      beep()
    }
  }, [left])
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  return (
    <div className="rest">
      <span>{left === 0 ? 'Descanso acabou!' : 'Descanso'}</span>
      <span className="t">{mm}:{ss}</span>
      <button onClick={() => onChange(Math.max(Date.now(), endAt - 15000))}>−15s</button>
      <button onClick={() => onChange(endAt + 15000)}>+15s</button>
      <button onClick={onClear}>✕</button>
    </div>
  )
}
