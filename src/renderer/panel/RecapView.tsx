/**
 * RecapView —— 任务回顾页签（v1.2.0）
 * 今日小结（球球口吻，zh/en 模板）+ 任务卡列表（DNA 徽章 + prompt 标题 + 元行）+ 日期导航
 * 规格见 docs/ROADMAP-v2.md A.5/A.6
 */
import { useCallback, useEffect, useState } from 'react'
import { TaskCard, RecapTotals } from '../../core/recap'
import { buildGlyphParams, polygonPoints } from '../../shared/dna'
import { t, I18nKey, getLocale } from '../../shared/i18n'
import { formatDuration } from './Panel'
import { ChevronRight, Radar } from '../shared/icons'

/** DNA 徽章（确定性参数 -> SVG） */
function DnaBadge({ card }: { card: TaskCard }) {
  const g = buildGlyphParams(card)
  const isCustom = card.agentType === 'custom'
  const color = isCustom ? '#8b949e' : `hsl(${g.hue} 70% 62%)`
  const segs = []
  for (let i = 0; i < g.segments; i++) {
    const a0 = ((i / g.segments) * 360 + g.rotation) * (Math.PI / 180)
    const a1 = (((i + 0.62) / g.segments) * 360 + g.rotation) * (Math.PI / 180)
    const r1 = 17
    segs.push(
      <line
        key={i}
        x1={20 + r1 * Math.cos(a0)}
        y1={20 + r1 * Math.sin(a0)}
        x2={20 + r1 * Math.cos(a1)}
        y2={20 + r1 * Math.sin(a1)}
        stroke={color}
        strokeWidth={g.ringWidth}
        strokeLinecap="round"
      />
    )
  }
  return (
    <svg className="dna-badge" width={40} height={40} viewBox="0 0 40 40" aria-hidden>
      {segs}
      <polygon
        points={polygonPoints(g.sides, 8, g.rotation)}
        fill="none"
        stroke={color}
        strokeWidth={1.2}
      />
      {Array.from({ length: g.dots }).map((_, i) => {
        const a = ((i / g.dots) * 360 + g.rotation * 2) * (Math.PI / 180)
        return (
          <circle key={i} cx={20 + 4.2 * Math.cos(a)} cy={20 + 4.2 * Math.sin(a)} r={1.1} fill={color} />
        )
      })}
      {g.glow > 0 && <circle cx={20} cy={20} r={17} fill="none" stroke={color} strokeWidth={g.glow} opacity={0.18} />}
    </svg>
  )
}

/** 任务卡工具 Top3 文案 */
function toolsTop(card: TaskCard): string {
  return Object.entries(card.tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => `${name}×${n}`)
    .join(' ')
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 今日小结（球球口吻）：优先级 深夜 > 氪金 > 有错 > 全绿 */
function digestLine(totals: RecapTotals, cards: TaskCard[]): string {
  const lateNight = cards.some((c) => {
    const h = new Date(c.startedAt).getHours()
    return h >= 1 && h < 6
  })
  const expensive = totals.costUsd >= 5
  const pick = (key: I18nKey, vars: Record<string, string | number>): string => {
    let s = t(key)
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v))
    return s
  }
  if (lateNight) return pick('recapDigestLate', {})
  if (expensive) return pick('recapDigestExpensive', { c: totals.costUsd.toFixed(2) })
  if (totals.errors > 0)
    return pick('recapDigestErrors', { n: totals.tasks, e: totals.errors })
  return pick('recapDigestAllGreen', { n: totals.tasks })
}

function dayTitle(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  const now = new Date()
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return t('recapToday')
  if (diff === 1) return t('recapYesterday')
  return getLocale() === 'en' ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getMonth() + 1}月${d.getDate()}日`
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function RecapView() {
  const [date, setDate] = useState<string>(() => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })
  const [data, setData] = useState<{ cards: TaskCard[]; totals: RecapTotals } | null>(null)

  const load = useCallback((d: string): void => {
    void window.pupil
      .getRecap(d)
      .then((r) => setData({ cards: r.cards, totals: r.totals }))
      .catch(() => setData({ cards: [], totals: { tasks: 0, errors: 0, runMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 } }))
  }, [])

  useEffect(() => {
    load(date)
    // 打开期间轻量轮询（进行中的任务卡实时更新）
    const timer = setInterval(() => load(date), 3000)
    return () => clearInterval(timer)
  }, [date, load])

  const isFuture = date > shiftDate(new Date().toISOString().slice(0, 10), 0)

  return (
    <div className="recap-view">
      {/* 日期导航 */}
      <div className="recap-nav">
        <button className="icon-btn" aria-label="prev" onClick={() => setDate(shiftDate(date, -1))}>
          <ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span className="recap-date">{dayTitle(date)}</span>
        {!isFuture && (
          <button className="icon-btn" aria-label="next" onClick={() => setDate(shiftDate(date, 1))}>
            <ChevronRight size={14} />
          </button>
        )}
        <span className="recap-count">
          {data?.totals.tasks ?? 0} {t('recapTasks')}
        </span>
      </div>

      {/* 今日小结（有数据才显示） */}
      {data && data.cards.length > 0 && (
        <div className="recap-digest">🖤 {digestLine(data.totals, data.cards)}</div>
      )}

      {/* 卡片列表 */}
      {!data ? (
        <div className="history-empty">{t('historyLoading')}</div>
      ) : data.cards.length === 0 ? (
        <div className="history-empty">
          <Radar size={28} strokeWidth={1.5} />
          {t('recapEmpty')}
        </div>
      ) : (
        <ul className="recap-list">
          {data.cards.map((c) => (
            <li key={c.id} className="recap-card">
              <DnaBadge card={c} />
              <div className="recap-main">
                <div className="recap-title">{c.prompt ?? c.sessionTitle ?? c.id.split(':').slice(1).join(':')}</div>
                <div className="recap-meta">
                  <span className="agent-tag">{c.agentType}</span>
                  <span>{new Date(c.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {c.endedAt && <span>{formatDuration(c.endedAt - c.startedAt)}</span>}
                </div>
                {(Object.keys(c.tools).length > 0 || c.tokensIn + c.tokensOut > 0 || c.files.length > 0) && (
                  <div className="recap-stats">
                    {Object.keys(c.tools).length > 0 && <span>{toolsTop(c)}</span>}
                    {c.tokensIn + c.tokensOut > 0 && <span>{fmtTokens(c.tokensIn + c.tokensOut)} tok</span>}
                    {c.costUsd > 0 && <span>${c.costUsd.toFixed(2)}</span>}
                  </div>
                )}
                {c.files.length > 0 && (
                  <div className="recap-files">
                    {c.files.slice(0, 6).join('  ')}
                    {c.files.length > 6 ? ` ${t('recapMoreFiles').replace('{n}', String(c.files.length - 6))}` : ''}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 底部合计 */}
      {data && data.cards.length > 0 && (
        <div className="recap-total">
          {t('recapTotal')} · {data.totals.tasks} {t('recapTasks')} ·{' '}
          {formatDuration(data.totals.runMs)} · {fmtTokens(data.totals.tokensIn + data.totals.tokensOut)} tok
          {data.totals.costUsd > 0 ? ` · $${data.totals.costUsd.toFixed(2)}` : ''}
        </div>
      )}
    </div>
  )
}
