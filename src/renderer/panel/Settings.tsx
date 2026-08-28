/**
 * Settings —— 设置视图（面板内）
 * v0.7.0 模块化三页签；v1.0.0 i18n（zh/en 字典见 shared/i18n.ts）
 */
import React, { useCallback, useEffect, useState } from 'react'
import { SettingsSnapshot, UpdateCheckResult } from '../../shared/ipc-channels'
import { SoundKind, NotifyFilter, NOTIFY_FILTER_DEFAULTS } from '../../shared/events'
import { Moon, VolumeX, ChevronRight, X, Rocket, Music, Volume2, Download } from '../shared/icons'
import { listSoundPacks, setSoundConfig, playSound } from '../ball/sound'
import { formatSpeed } from '../../shared/format'
import { t, I18nKey } from '../../shared/i18n'

interface Props {
  onBack: () => void
}

/** 音色包选项（与 sound.ts PACKS 一致） */
const SOUND_PACKS = listSoundPacks()

/** 可自定义音频的事件类型（对应 SoundKind） */
const CUSTOM_SOUND_KINDS: { id: SoundKind; labelKey: I18nKey }[] = [
  { id: 'done', labelKey: 'soundDone' },
  { id: 'ended', labelKey: 'soundEnded' },
  { id: 'waiting', labelKey: 'soundWaiting' },
  { id: 'error', labelKey: 'soundError' },
  { id: 'timeout', labelKey: 'soundTimeout' },
  { id: 'offline', labelKey: 'soundOffline' }
]

/** 设置分组 */
type SettingTab = 'general' | 'sound' | 'access'
const SETTING_TABS: { id: SettingTab; labelKey: I18nKey }[] = [
  { id: 'general', labelKey: 'tabGeneral' },
  { id: 'sound', labelKey: 'tabSound' },
  { id: 'access', labelKey: 'tabAccess' }
]

function loadLastTab(): SettingTab {
  try {
    const saved = localStorage.getItem('pupil.settingsTab') as SettingTab | null
    if (saved && SETTING_TABS.some((tab) => tab.id === saved)) return saved
  } catch {
    /* storage 不可用时不影响 */
  }
  return 'general'
}

/** 更新状态说明文案 */
function updateDesc(u: UpdateCheckResult | null): string {
  if (!u || u.status === 'disabled') return t('autoCheckHint')
  if (u.status === 'dev') return t('devNoCheck')
  switch (u.status) {
    case 'checking':
      return t('checking')
    case 'available':
      return `${t('foundNewVersion')} v${u.latestVersion ?? ''} · ${t('availableHint')}`
    case 'downloading':
      if (u.progress == null) return t('connectingSources')
      return `${t('updateProgressText')} ${u.progress}%${formatSpeed(u.speedBps) ? ` · ${formatSpeed(u.speedBps)}` : ''}`
    case 'downloaded':
      return t('downloadedHint')
    case 'not-available':
      return t('upToDate')
    case 'error':
      return `${t('checkFailed')}: ${u.error ?? t('unknownError')}`
    default:
      return ''
  }
}

/** 音色试听用事件音（切换包/拖滑块时播一次） */
const PREVIEW_SOUND = 'done' as const

/** 开关（按钮模拟） */
function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      className={`toggle ${on ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="toggle-knob" />
    </button>
  )
}

export function Settings({ onBack }: Props) {
  const [snap, setSnap] = useState<SettingsSnapshot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  /** 拖动中的临时音量（未提交）；null = 显示已保存值 */
  const [localVolume, setLocalVolume] = useState<number | null>(null)
  const [tab, setTab] = useState<SettingTab>(loadLastTab)

  const selectTab = (next: SettingTab): void => {
    setTab(next)
    try {
      localStorage.setItem('pupil.settingsTab', next)
    } catch {
      /* ignore */
    }
  }

  const reload = useCallback(async () => {
    setSnap(await window.pupil.getSettings())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 下载进行中：轮询主进程拿实时进度
  useEffect(() => {
    if (update?.status !== 'downloading') return
    const timer = setInterval(() => {
      void window.pupil.getUpdateStatus().then(setUpdate).catch(() => undefined)
    }, 500)
    return () => clearInterval(timer)
  }, [update?.status])

  const toggleDnd = async (): Promise<void> => {
    if (!snap) return
    await window.pupil.setSettings({ dnd: !snap.dnd })
    void reload()
  }

  const toggleMuted = async (): Promise<void> => {
    if (!snap) return
    await window.pupil.setSettings({ muted: !snap.muted })
    void reload()
  }

  const toggleAutoLaunch = async (): Promise<void> => {
    if (!snap) return
    await window.pupil.setSettings({ autoLaunch: !snap.autoLaunch })
    void reload()
  }

  /** v0.8.0 通知粒度：按类别开关「音效+系统通知」 */
  const NOTIFY_GRANULARITY: { key: keyof NotifyFilter; labelKey: I18nKey; descKey: I18nKey }[] = [
    { key: 'turn_completed', labelKey: 'granCompleted', descKey: 'granCompletedDesc' },
    { key: 'waiting_input', labelKey: 'granWaiting', descKey: 'granWaitingDesc' },
    { key: 'error', labelKey: 'granError', descKey: 'granErrorDesc' },
    { key: 'timeout', labelKey: 'granTimeout', descKey: 'granTimeoutDesc' },
    { key: 'offline', labelKey: 'granOffline', descKey: 'granOfflineDesc' }
  ]
  const toggleNotifyEvent = async (key: keyof NotifyFilter): Promise<void> => {
    if (!snap) return
    const current = { ...NOTIFY_FILTER_DEFAULTS, ...snap.notifyEvents }
    await window.pupil.setSettings({ notifyEvents: { ...current, [key]: !current[key] } })
    void reload()
  }

  /** 切换音色包：持久化 + 立即试听一声 */
  const changeSoundPack = async (pack: string): Promise<void> => {
    if (!snap) return
    setSoundConfig(pack, snap.soundVolume)
    playSound(PREVIEW_SOUND)
    await window.pupil.setSettings({ soundPack: pack })
    void reload()
  }

  /** 拖动音量滑块：本地即时试听，change 时持久化 */
  const previewVolume = (v: number): void => {
    if (!snap) return
    setSoundConfig(snap.soundPack, v)
    setLocalVolume(v)
    playSound(PREVIEW_SOUND)
  }
  const commitVolume = async (v: number): Promise<void> => {
    await window.pupil.setSettings({ soundVolume: v })
    void reload()
  }

  const toggleAdapter = async (id: string, enabled: boolean): Promise<void> => {
    if (!snap) return
    setBusy(id)
    try {
      await window.pupil.setAdapterEnabled(id, enabled)
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const checkUpdate = async (): Promise<void> => {
    setUpdateBusy(true)
    try {
      setUpdate(await window.pupil.checkUpdate())
    } finally {
      setUpdateBusy(false)
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    setUpdateBusy(true)
    try {
      setUpdate(await window.pupil.downloadUpdate())
    } finally {
      setUpdateBusy(false)
    }
  }

  const pickCustomSound = async (kind: SoundKind): Promise<void> => {
    setBusy(`sound-${kind}`)
    try {
      setSnap(await window.pupil.pickCustomSound(kind))
    } finally {
      setBusy(null)
    }
  }

  const clearCustomSound = async (kind: SoundKind): Promise<void> => {
    setBusy(`sound-${kind}`)
    try {
      setSnap(await window.pupil.clearCustomSound(kind))
    } finally {
      setBusy(null)
    }
  }

  const previewCustomSound = async (kind: SoundKind): Promise<void> => {
    await window.pupil.previewCustomSound(kind)
  }

  const hooksAction = async (install: boolean): Promise<void> => {
    setBusy('hooks')
    try {
      if (install) await window.pupil.installHooks()
      else await window.pupil.uninstallHooks()
      await reload()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel">
      {/* v0.3.4：独立设置窗口无边框，顶栏即拖动区。按钮设 no-drag 保持可点。 */}
      <header className="panel-top" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="settings-title">
          <button
            className="icon-btn"
            aria-label={t('back')}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={onBack}
          >
            <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <span>{t('settings')}</span>
        </div>
        <button
          className="icon-btn"
          aria-label={t('close')}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={onBack}
        >
          <X size={16} />
        </button>
      </header>

      {/* 模块化导航（固定不随内容滚动） */}
      {snap && (
        <nav className="settings-nav" role="tablist" aria-label={t('settings')}>
          {SETTING_TABS.map((tb) => (
            <button
              key={tb.id}
              role="tab"
              aria-selected={tab === tb.id}
              className={`settings-tab ${tab === tb.id ? 'active' : ''}`}
              onClick={() => selectTab(tb.id)}
            >
              {t(tb.labelKey)}
            </button>
          ))}
        </nav>
      )}

      <div className="panel-body settings-body">
        {!snap ? (
          <div className="settings-loading">{t('loading')}</div>
        ) : (
          <div className="settings-view" key={tab}>
            {/* ---------- 通用 ---------- */}
            {tab === 'general' && (
              <>
                <section className="settings-section">
                  <h3 className="settings-heading">{t('localeRow')}</h3>
                  <div className="setting-row">
                    <div className="setting-info">
                      <div>
                        <div className="setting-name">{t('localeRow')}</div>
                        <div className="setting-desc">{t('followSystem')} / 中文 / English</div>
                      </div>
                    </div>
                    <select
                      className="sound-select"
                      value={snap.locale ?? 'system'}
                      onChange={(e) =>
                        void window.pupil.setSettings({
                          locale: e.target.value as 'system' | 'zh' | 'en'
                        })
                      }
                    >
                      <option value="system">{t('followSystem')}</option>
                      <option value="zh">{t('langZh')}</option>
                      <option value="en">{t('langEn')}</option>
                    </select>
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-heading">{t('headingAlertMode')}</h3>
                  <div className="setting-row">
                    <div className="setting-info">
                      <Moon size={16} />
                      <div>
                        <div className="setting-name">{t('dnd')}</div>
                        <div className="setting-desc">{t('dndDesc')}</div>
                      </div>
                    </div>
                    <Toggle on={snap.dnd} onChange={() => void toggleDnd()} />
                  </div>
                  <div className="setting-row">
                    <div className="setting-info">
                      <VolumeX size={16} />
                      <div>
                        <div className="setting-name">{t('muted')}</div>
                        <div className="setting-desc">{t('mutedDesc')}</div>
                      </div>
                    </div>
                    <Toggle on={snap.muted} onChange={() => void toggleMuted()} />
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-heading">{t('headingSystem')}</h3>
                  <div className="setting-row">
                    <div className="setting-info">
                      <Rocket size={16} />
                      <div>
                        <div className="setting-name">{t('autoLaunch')}</div>
                        <div className="setting-desc">
                          {snap.autoLaunch ? t('autoLaunchOn') : t('autoLaunchOff')}
                        </div>
                      </div>
                    </div>
                    <Toggle on={snap.autoLaunch} onChange={() => void toggleAutoLaunch()} />
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-heading">{t('headingGranularity')}</h3>
                  <p className="settings-hint">{t('granularityHint')}</p>
                  {NOTIFY_GRANULARITY.map((g) => {
                    const current = { ...NOTIFY_FILTER_DEFAULTS, ...snap.notifyEvents }
                    return (
                      <div className="setting-row" key={g.key}>
                        <div className="setting-info">
                          <div>
                            <div className="setting-name">{t(g.labelKey)}</div>
                            <div className="setting-desc">{t(g.descKey)}</div>
                          </div>
                        </div>
                        <Toggle on={current[g.key] !== false} onChange={() => void toggleNotifyEvent(g.key)} />
                      </div>
                    )
                  })}
                </section>

                <section className="settings-section">
                  <h3 className="settings-heading">{t('headingAbout')}</h3>
                  <div className="setting-row">
                    <div className="setting-info">
                      <Download size={16} />
                      <div>
                        <div className="setting-name">
                          {t('currentVersion')} v{snap.version}
                        </div>
                        <div className="setting-desc">{updateDesc(update)}</div>
                      </div>
                    </div>
                    <button
                      className="hooks-btn"
                      disabled={updateBusy}
                      onClick={() => void checkUpdate()}
                    >
                      {updateBusy
                        ? update?.status === 'downloading'
                          ? t('downloading')
                          : t('processing')
                        : t('checkUpdate')}
                    </button>
                  </div>
                  {update?.status === 'downloading' && (
                    <div className="update-progress">
                      <div className="update-progress-track">
                        <div
                          className="update-progress-fill"
                          style={{ width: `${update.progress ?? 2}%` }}
                        />
                      </div>
                      <span className="update-progress-text">
                        {update.progress != null
                          ? `${t('updateProgressText')} ${update.progress}%${formatSpeed(update.speedBps) ? ` · ${formatSpeed(update.speedBps)}` : ''}`
                          : t('connectingSources')}
                      </span>
                    </div>
                  )}
                  {update?.status === 'available' && (
                    <div className="setting-row">
                      <div className="setting-info">
                        <div>
                          <div className="setting-name">
                            {t('foundNewVersion')} v{update.latestVersion}
                          </div>
                          <div className="setting-desc">{t('silentInstallHint')}</div>
                        </div>
                      </div>
                      <button
                        className="hooks-btn"
                        disabled={updateBusy}
                        onClick={() => void downloadUpdate()}
                      >
                        {t('downloadUpdate')}
                      </button>
                    </div>
                  )}
                  {update?.status === 'available' && (
                    <div className="setting-row">
                      <button
                        className="hooks-btn"
                        onClick={() => void window.pupil.openUpdatePage()}
                      >
                        {t('openReleasePage')}
                      </button>
                    </div>
                  )}
                </section>
              </>
            )}

            {/* ---------- 音效 ---------- */}
            {tab === 'sound' && (
              <>
                <section className="settings-section">
                  <h3 className="settings-heading">{t('headingSound')}</h3>
                  <div className="setting-row">
                    <div className="setting-info">
                      <Music size={16} />
                      <div>
                        <div className="setting-name">{t('soundPack')}</div>
                        <div className="setting-desc">{t('soundPackDesc')}</div>
                      </div>
                    </div>
                    <select
                      className="sound-select"
                      value={snap.soundPack}
                      onChange={(e) => void changeSoundPack(e.target.value)}
                    >
                      {SOUND_PACKS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div className="setting-info">
                      <Volume2 size={16} />
                      <div>
                        <div className="setting-name">{t('volume')}</div>
                        <div className="setting-desc">{t('volumeDesc')}</div>
                      </div>
                    </div>
                    <input
                      type="range"
                      className="volume-slider"
                      min={0}
                      max={100}
                      value={Math.round((localVolume ?? snap.soundVolume) * 100)}
                      onChange={(e) => previewVolume(Number(e.target.value) / 100)}
                      onMouseUp={(e) => void commitVolume(Number((e.target as HTMLInputElement).value) / 100)}
                      onTouchEnd={(e) => void commitVolume(Number((e.target as HTMLInputElement).value) / 100)}
                      onKeyUp={(e) => void commitVolume(Number((e.target as HTMLInputElement).value) / 100)}
                      aria-label={t('volume')}
                    />
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-heading">{t('headingCustomSound')}</h3>
                  <p className="settings-hint">{t('customSoundHint')}</p>
                  {CUSTOM_SOUND_KINDS.map((s) => {
                    const info = snap.customSounds?.[s.id]
                    return (
                      <div className="setting-row" key={s.id}>
                        <div className="setting-info">
                          <div>
                            <div className="setting-name">
                              {t(s.labelKey)}
                              {t('soundSuffix')}
                            </div>
                            <div className="setting-desc">
                              {info ? info.name : t('soundDefaultDesc')}
                            </div>
                          </div>
                        </div>
                        <div className="custom-sound-actions">
                          {info && (
                            <button
                              className="hooks-btn"
                              disabled={busy === `sound-${s.id}`}
                              onClick={() => void previewCustomSound(s.id)}
                            >
                              {t('preview')}
                            </button>
                          )}
                          <button
                            className="hooks-btn"
                            disabled={busy === `sound-${s.id}`}
                            onClick={() => void pickCustomSound(s.id)}
                          >
                            {info ? t('replace') : t('pick')}
                          </button>
                          {info && (
                            <button
                              className="hooks-btn danger"
                              disabled={busy === `sound-${s.id}`}
                              onClick={() => void clearCustomSound(s.id)}
                            >
                              {t('clear')}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </section>
              </>
            )}

            {/* ---------- 接入 ---------- */}
            {tab === 'access' && (
              <>
                <section className="settings-section">
                  <h3 className="settings-heading">{t('headingAdapters')}</h3>
                  {snap.adapters.map((a) => (
                    <div className="setting-row" key={a.id}>
                      <div className="setting-info">
                        <span
                          className={`adapter-dot ${a.running ? 'run' : ''} ${!a.available ? 'off' : ''}`}
                        />
                        <div>
                          <div className="setting-name">{a.label}</div>
                          <div className="setting-desc">
                            {!a.available
                              ? t('adapterUnavailable')
                              : a.running
                                ? t('adapterRunning')
                                : a.enabled
                                  ? t('adapterEnabled')
                                  : t('adapterDisabled')}
                          </div>
                        </div>
                      </div>
                      <Toggle
                        on={a.enabled}
                        disabled={!a.available || busy === a.id}
                        onChange={() => void toggleAdapter(a.id, !a.enabled)}
                      />
                    </div>
                  ))}
                </section>

                <section className="settings-section">
                  <h3 className="settings-heading">{t('headingHooks')}</h3>
                  <div className="setting-row">
                    <div className="setting-info">
                      <div>
                        <div className="setting-name">
                          {snap.hooksInstalled ? t('hooksInstalled') : t('hooksNotInstalled')}
                        </div>
                        <div className="setting-desc">{t('hooksDesc')}</div>
                      </div>
                    </div>
                    <button
                      className={`hooks-btn ${snap.hooksInstalled ? 'danger' : ''}`}
                      disabled={busy === 'hooks'}
                      onClick={() => void hooksAction(!snap.hooksInstalled)}
                    >
                      {busy === 'hooks' ? t('processing') : snap.hooksInstalled ? t('uninstall') : t('install')}
                    </button>
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
