import { useEffect, useRef, useState } from 'react'
import { PromptTitle } from '../components/TerminalChrome'
import { useSetting, useSyncStatus } from '../hooks'
import {
  countUnreadNoticias,
  fetchIfesNoticiasOnce,
  formatIfesPublishedAt,
  markAllIfesNewsRead,
  markIfesNewsRead,
  subscribeIfesNoticias,
  type IfesNoticia,
} from '../lib/notifications'

export default function Noticias({
  items: externalItems,
  loading: externalLoading,
  error: externalError,
  onManualRefresh,
}: {
  items?: IfesNoticia[]
  loading?: boolean
  error?: string | null
  onManualRefresh?: () => Promise<void>
}) {
  const syncStatus = useSyncStatus()
  const readIdsRaw = useSetting<string[]>('ifesReadIds', [])
  const readIds = Array.isArray(readIdsRaw) ? readIdsRaw : []
  const readSet = new Set(readIds)

  const [localItems, setLocalItems] = useState<IfesNoticia[]>([])
  const [localLoading, setLocalLoading] = useState<boolean>(true)
  const [localError, setLocalError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [pullDistance, setPullDistance] = useState<number>(0)
  const touchStartYRef = useRef<number | null>(null)

  const useExternal = externalItems !== undefined

  useEffect(() => {
    if (useExternal) return
    if (!syncStatus.user) {
      setLocalItems([])
      setLocalLoading(false)
      setLocalError(null)
      return
    }
    setLocalLoading(true)
    setLocalError(null)
    const unsub = subscribeIfesNoticias(
      (list) => {
        setLocalItems(list)
        setLocalLoading(false)
        setLocalError(null)
      },
      (err) => {
        setLocalLoading(false)
        setLocalError(err.message || 'Falha ao carregar notícias do Firestore.')
      },
      50,
    )
    return () => unsub()
  }, [useExternal, syncStatus.user?.uid])

  const items = useExternal ? externalItems : localItems
  const loading = useExternal ? Boolean(externalLoading) : localLoading
  const error = useExternal ? (externalError ?? null) : localError
  const unreadCount = countUnreadNoticias(items, readIds)

  const handleRefresh = async () => {
    if (refreshing) return
    if (!syncStatus.user) return
    setRefreshing(true)
    try {
      if (onManualRefresh) {
        await onManualRefresh()
      } else {
        const fresh = await fetchIfesNoticiasOnce(50)
        setLocalItems(fresh)
        setLocalError(null)
      }
    } catch (e) {
      const msg = (e as Error)?.message || 'Falha ao atualizar notícias.'
      if (!useExternal) setLocalError(msg)
    } finally {
      setRefreshing(false)
    }
  }

  const handleOpenCard = (item: IfesNoticia) => {
    setExpandedId((prev) => (prev === item.id ? null : item.id))
    if (!readSet.has(item.id)) {
      void markIfesNewsRead(item.id)
    }
  }

  const handleOpenOriginal = (item: IfesNoticia) => {
    if (!readSet.has(item.id)) {
      void markIfesNewsRead(item.id)
    }
  }

  // Pull-to-refresh simples via eventos de toque quando o scroll está no topo
  const onTouchStart = (e: React.TouchEvent) => {
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0
    if (scrollTop <= 2 && e.touches.length === 1) {
      touchStartYRef.current = e.touches[0].clientY
    } else {
      touchStartYRef.current = null
    }
  }

  const onTouchMove = (e: React.TouchEvent) => {
    if (touchStartYRef.current === null) return
    const dy = e.touches[0].clientY - touchStartYRef.current
    if (dy > 0 && dy < 130) {
      setPullDistance(dy)
    } else if (dy <= 0) {
      setPullDistance(0)
    }
  }

  const onTouchEnd = () => {
    if (pullDistance >= 65) {
      void handleRefresh()
    }
    touchStartYRef.current = null
    setPullDistance(0)
  }

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <PromptTitle path="~/noticias" />

      <div className="card stack">
        <div className="row between">
          <b>Ifes · Campus Vitória</b>
          <span className={`chip ${unreadCount > 0 ? 'green' : ''}`}>
            {unreadCount > 0 ? `${unreadCount} não lida(s)` : 'tudo lido'}
          </span>
        </div>

        <div className="row wrap">
          <button
            className="small primary"
            disabled={refreshing || !syncStatus.user}
            onClick={() => void handleRefresh()}
          >
            {refreshing ? 'atualizando…' : 'atualizar'}
          </button>
          {unreadCount > 0 && (
            <button
              className="small"
              onClick={() => void markAllIfesNewsRead(items.map((x) => x.id))}
            >
              marcar lidas
            </button>
          )}
        </div>

        {pullDistance > 18 && (
          <div className="muted small" style={{ textAlign: 'center' }}>
            {pullDistance >= 65 ? '↑ solte para atualizar…' : '↓ puxe para atualizar…'}
          </div>
        )}
      </div>

      {!syncStatus.user && (
        <div className="card">
          <div className="amber small">
            Entre na conta em <b>~/config</b> para sincronizar notícias.
          </div>
        </div>
      )}

      {syncStatus.user && error && (
        <div className="card stack" style={{ borderColor: 'var(--red)' }}>
          <div className="red">error: {error}</div>
          <button className="small" onClick={() => void handleRefresh()}>
            tentar novamente
          </button>
        </div>
      )}

      {syncStatus.user && loading && items.length === 0 && !error && (
        <div className="card">
          <div className="muted small">&gt; carregando…</div>
        </div>
      )}

      {syncStatus.user && !loading && !error && items.length === 0 && (
        <div className="card muted small">Nenhuma notícia sincronizada ainda.</div>
      )}

      {items.map((item) => {
        const isUnread = !readSet.has(item.id)
        const isExpanded = expandedId === item.id
        return (
          <div
            key={item.id}
            className="card stack"
            style={{
              borderColor: isUnread ? 'var(--green)' : 'var(--border)',
              cursor: 'pointer',
            }}
            onClick={() => handleOpenCard(item)}
          >
            <div className="row between">
              <span className="muted small">{formatIfesPublishedAt(item.publishedAt)}</span>
              {isUnread ? (
                <span className="tag-pr">não lida</span>
              ) : (
                <span className="muted small">lida</span>
              )}
            </div>

            <div style={{ fontWeight: isUnread ? 700 : 600, color: 'var(--text)' }}>
              {item.title}
            </div>

            {item.summary && (
              <div className="muted small" style={{ lineHeight: 1.45 }}>
                {item.summary}
              </div>
            )}

            {(isExpanded || isUnread) && (
              <div className="row between" style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="news-link-btn"
                  onClick={() => handleOpenOriginal(item)}
                >
                  abrir matéria original ↗
                </a>
                {isUnread && (
                  <button
                    className="small ghost"
                    onClick={() => void markIfesNewsRead(item.id)}
                  >
                    marcar lida
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
