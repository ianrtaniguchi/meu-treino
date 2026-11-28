/**
 * Regras da saudação de abertura (splash).
 *
 * Tudo que se ajusta fica aqui, em constantes:
 *  - SPLASH_MIN_INTERVAL_MS: intervalo mínimo entre saudações quando o app é aberto ou retomado SEM trava.
 *  - SPLASH_UNLOCK_MIN_INTERVAL_MS: intervalo mínimo após um desbloqueio (Face ID/PIN) ou login novo.
 *    0 = sempre mostra logo depois de desbloquear/entrar. Suba (ex.: 5 * 60_000) se achar repetitivo.
 */
export const SPLASH_MIN_INTERVAL_MS = 30 * 60 * 1000 // 30 minutos
export const SPLASH_UNLOCK_MIN_INTERVAL_MS = 0

export const SPLASH_STORAGE_KEY = 'meu_treino_last_splash_at'

/** Tempo com a frase visível antes do fade-out e duração do fade-out (ms). */
export const SPLASH_HOLD_MS = 1950
export const SPLASH_FADEOUT_MS = 520
/** Com prefers-reduced-motion não há fade: a saudação some em corte seco após este tempo (ms). */
export const SPLASH_REDUCED_MOTION_MS = 1400

export type SplashReason = 'cold-start' | 'resume' | 'unlock' | 'login'

export function splashIntervalFor(reason: SplashReason): number {
  return reason === 'unlock' || reason === 'login'
    ? SPLASH_UNLOCK_MIN_INTERVAL_MS
    : SPLASH_MIN_INTERVAL_MS
}

export function readLastSplashAt(): number | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(SPLASH_STORAGE_KEY)
    if (!raw) return null
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * Decide se a saudação deve aparecer agora.
 * `lastAt` nulo (nunca mostrada) ou relógio que andou para trás => mostra.
 */
export function shouldShowSplash(
  nowMs: number,
  minIntervalMs: number,
  lastAt: number | null = readLastSplashAt(),
): boolean {
  if (minIntervalMs <= 0) return true
  if (lastAt === null) return true
  if (lastAt > nowMs) return true
  return nowMs - lastAt >= minIntervalMs
}

export function recordSplashShown(nowMs = Date.now()): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SPLASH_STORAGE_KEY, String(nowMs))
    }
  } catch {
    // ignora localStorage indisponível
  }
}
