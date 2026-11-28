import { ASSISTANT_WORKER_URL } from '../assistantConfig'
import { getFirebaseAuth } from '../data/sync'

export const MIN_RECORDING_DURATION_MS = 600
export const MAX_AUDIO_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

export interface AudioMimeChoice {
  mimeType: string
  extension: 'webm' | 'm4a' | 'mp4' | 'ogg' | 'wav'
  filename: string
}

export interface RecordedAudioClip {
  blob: Blob
  mimeType: string
  filename: string
  durationMs: number
}

export interface ActiveAudioRecorder {
  mimeType: string
  stop: () => Promise<RecordedAudioClip>
  cancel: () => void
}

const MIME_CANDIDATES: Array<{ mime: string; ext: AudioMimeChoice['extension'] }> = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/aac', ext: 'm4a' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mime: 'audio/wav', ext: 'wav' },
]

export function extensionForAudioMime(mimeType: string): AudioMimeChoice['extension'] {
  const m = (mimeType || '').toLowerCase()
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a') || m.includes('x-m4a')) {
    return 'm4a'
  }
  if (m.includes('ogg') || m.includes('opus') && !m.includes('webm')) {
    return 'ogg'
  }
  if (m.includes('wav')) {
    return 'wav'
  }
  return 'webm'
}

export function filenameForAudioMime(mimeType: string): string {
  return `gravacao.${extensionForAudioMime(mimeType)}`
}

/**
 * Detecta dinamicamente o melhor formato de áudio suportado pelo navegador:
 * - No PC (Edge/Brave/Chrome): prioriza `audio/webm;codecs=opus` ou `audio/webm`
 * - No iPhone (iOS Safari/WebKit PWA): prioriza `audio/mp4` ou `audio/aac` (`gravacao.m4a`)
 */
export function detectSupportedAudioMime(
  isTypeSupported?: (mime: string) => boolean,
): AudioMimeChoice {
  const check =
    isTypeSupported ??
    (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? (m: string) => MediaRecorder.isTypeSupported(m)
      : undefined)

  if (check) {
    for (const c of MIME_CANDIDATES) {
      try {
        if (check(c.mime)) {
          return {
            mimeType: c.mime,
            extension: c.ext,
            filename: `gravacao.${c.ext}`,
          }
        }
      } catch {
        // continua testando candidatos
      }
    }
  }

  return {
    mimeType: '',
    extension: 'm4a',
    filename: 'gravacao.m4a',
  }
}

export function describeMediaError(err: unknown): string {
  const e = err as { name?: string; message?: string } | undefined
  const name = e?.name ?? ''
  const msg = e?.message ?? ''
  if (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    msg.toLowerCase().includes('permission denied')
  ) {
    return 'error: permissão de microfone negada. Autorize o acesso ao microfone nos Ajustes do iOS ou do navegador.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'error: nenhum microfone encontrado neste dispositivo.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'error: não foi possível acessar o microfone (ele pode estar em uso por outro app).'
  }
  if (msg.startsWith('error:')) return msg
  return msg ? `error: ${msg}` : 'error: falha ao iniciar gravação de áudio.'
}

function stopAllStreamTracks(stream: MediaStream | null | undefined): void {
  if (!stream) return
  try {
    for (const track of stream.getTracks()) {
      try {
        track.stop()
      } catch {
        // ignora erro individual de track
      }
    }
  } catch {
    // ignora
  }
}

export async function startAudioRecording(): Promise<ActiveAudioRecorder> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error(
      'error: gravação de áudio não suportada neste navegador (exige HTTPS ou localhost).',
    )
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('error: MediaRecorder não disponível neste dispositivo.')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    throw new Error(describeMediaError(err))
  }

  const detected = detectSupportedAudioMime()
  let recorder: MediaRecorder
  try {
    recorder = detected.mimeType
      ? new MediaRecorder(stream, { mimeType: detected.mimeType })
      : new MediaRecorder(stream)
  } catch {
    try {
      recorder = new MediaRecorder(stream)
    } catch (err) {
      stopAllStreamTracks(stream)
      throw new Error(describeMediaError(err))
    }
  }

  const chunks: BlobPart[] = []
  const startedAt = Date.now()
  let cancelled = false
  let stopped = false

  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data)
    }
  }

  try {
    recorder.start(250)
  } catch (err) {
    stopAllStreamTracks(stream)
    throw new Error(describeMediaError(err))
  }

  const cancel = () => {
    if (stopped) return
    cancelled = true
    stopped = true
    try {
      if (recorder.state !== 'inactive') {
        recorder.stop()
      }
    } catch {
      // ignora
    } finally {
      stopAllStreamTracks(stream)
    }
  }

  const stop = (): Promise<RecordedAudioClip> =>
    new Promise<RecordedAudioClip>((resolve, reject) => {
      if (cancelled) {
        stopAllStreamTracks(stream)
        reject(new Error('error: gravação cancelada.'))
        return
      }

      const finalize = () => {
        stopAllStreamTracks(stream)
        const durationMs = Math.max(0, Date.now() - startedAt)
        if (durationMs < MIN_RECORDING_DURATION_MS) {
          reject(
            new Error('error: gravação muito curta (< 0,6s). Segure ou fale por pelo menos 1 segundo.'),
          )
          return
        }
        const actualMime =
          recorder.mimeType || detected.mimeType || 'audio/mp4'
        const blob = new Blob(chunks, { type: actualMime })
        if (!blob || blob.size === 0) {
          reject(new Error('error: nenhum áudio capturado pelo microfone.'))
          return
        }
        if (blob.size > MAX_AUDIO_FILE_BYTES) {
          reject(new Error('error: áudio excede o limite de 10 MB.'))
          return
        }
        resolve({
          blob,
          mimeType: actualMime,
          filename: filenameForAudioMime(actualMime),
          durationMs,
        })
      }

      if (recorder.state === 'inactive') {
        stopped = true
        finalize()
        return
      }

      recorder.onstop = () => {
        stopped = true
        finalize()
      }
      recorder.onerror = () => {
        stopped = true
        stopAllStreamTracks(stream)
        reject(new Error('error: falha durante a captura do áudio.'))
      }

      try {
        recorder.stop()
      } catch (err) {
        stopped = true
        stopAllStreamTracks(stream)
        reject(new Error(describeMediaError(err)))
      }
    })

  return {
    mimeType: recorder.mimeType || detected.mimeType || 'audio/mp4',
    stop,
    cancel,
  }
}

export interface TranscribeOptions {
  fetcher?: typeof fetch
  getToken?: () => Promise<string | null>
  workerUrl?: string
}

async function defaultGetIdToken(): Promise<string | null> {
  const user = getFirebaseAuth().currentUser
  if (!user) return null
  return user.getIdToken()
}

export async function transcribeAudioClip(
  clip: RecordedAudioClip,
  options: TranscribeOptions = {},
): Promise<string> {
  if (!clip || !clip.blob || clip.blob.size === 0) {
    throw new Error('error: áudio vazio.')
  }
  if (clip.durationMs < MIN_RECORDING_DURATION_MS) {
    throw new Error('error: gravação muito curta (< 0,6s).')
  }
  if (clip.blob.size > MAX_AUDIO_FILE_BYTES) {
    throw new Error('error: áudio excede o limite de 10 MB.')
  }

  const fetcher = options.fetcher ?? fetch
  const getToken = options.getToken ?? defaultGetIdToken
  const baseUrl = (options.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')

  const token = await getToken()
  if (!token) {
    throw new Error('error: entre na sua conta em Configurações para transcrever áudio.')
  }

  const form = new FormData()
  const filename = clip.filename || filenameForAudioMime(clip.mimeType)
  form.append('file', clip.blob, filename)

  let res: Response
  try {
    res = await fetcher(`${baseUrl}/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    })
  } catch {
    throw new Error('error: falha de rede ao enviar áudio para transcrição.')
  }

  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
  if (!res.ok) {
    const errMsg = data?.error || `error: falha ao transcrever áudio (HTTP ${res.status}).`
    throw new Error(errMsg.startsWith('error:') ? errMsg : `error: ${errMsg}`)
  }

  const text = typeof data?.text === 'string' ? data.text.trim() : ''
  if (!text) {
    throw new Error('error: nenhuma fala detectada no áudio. Tente falar mais perto do microfone.')
  }
  return text
}
