/**
 * useSessions —— 订阅主进程会话快照的 hook
 */
import { useEffect, useState } from 'react'
import { SessionView } from '../../shared/events'

export function useSessions(): SessionView[] {
  const [sessions, setSessions] = useState<SessionView[]>([])

  useEffect(() => {
    let alive = true
    window.pupil
      .getSessions()
      .then((views) => {
        if (alive) setSessions(views)
      })
      .catch(() => undefined)
    const off = window.pupil.onSessions((views) => setSessions(views))
    return () => {
      alive = false
      off()
    }
  }, [])

  return sessions
}
