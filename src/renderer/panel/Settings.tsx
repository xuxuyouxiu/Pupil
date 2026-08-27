/**
 * Settings —— 设置视图（面板内，MVP 并入面板，独立窗口 P1）
 * 分区：通知（勿扰/静音/音色包/音量）/ 数据接入（adapter 开关）/ Claude Code Hooks 管理
 */
import React, { useCallback, useEffect, useState } from 'react'
import { SettingsSnapshot, UpdateCheckResult } from '../../shared/ipc-channels'
import { Moon, VolumeX, ChevronRight, X, Rocket, Music, Volume2, Download } from '../shared/icons'
import { listSoundPacks, setSoundConfig, playSound } from '../ball/sound'

interface Props {
  onBack: () => void
}

/** 音色包选项（与 sound.ts PACKS 一致） */
const SOUND_PACKS = listSoundPacks()

/** 更新状态说明文案 */
function updateDesc(u: UpdateCheckResult | null): string {
  if (!u || u.status === 'disabled') return '启动后自动检查 GitHub Releases'
  if (u.status === 'dev') return '开发模式不检查更新'
  switch (u.status) {
    case 'checking':
      return '正在检查最新版本…'
    case 'available':
      return `发现 v${u.latestVersion ?? ''}，可点击下载更新`
    case 'downloading':
      return '正在下载安装包…'
    case 'downloaded':
      return '安装包已下载，请完成安装'
    case 'not-available':
      return '已是最新版本'
    case 'error':
      return `检查失败：${u.error ?? '未知错误'}`
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

  const reload = useCallback(async () => {
    setSnap(await window.pupil.getSettings())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

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

  /** 切换音色包：持久化 + 立即试听一声 */
  const changeSoundPack = async (pack: string): Promise<void> => {
    if (!snap) return
    setSoundConfig(pack, snap.soundVolume)
    playSound(PREVIEW_SOUND)
    await window.pupil.setSettings({ soundPack: pack })
    void reload()
  }

  /** 拖动音量滑块：本地即时试听（节流由 input 事件天然限频），change 时持久化 */
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
      {/* v0.3.4：独立设置窗口无边框，顶栏即拖动区（-webkit-app-region: drag）。
          按钮设 no-drag 保持可点。修复「设置窗口卡在屏幕中心拖不动」。 */}
      <header className="panel-top" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="settings-title">
          <button
            className="icon-btn"
            aria-label="返回"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={onBack}
          >
            <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <span>设置</span>
        </div>
        <button
          className="icon-btn"
          aria-label="关闭"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={onBack}
        >
          <X size={16} />
        </button>
      </header>

      <div className="panel-body settings-body">
        {!snap ? (
          <div className="settings-loading">加载中…</div>
        ) : (
          <>
            {/* 通知 */}
            <section className="settings-section">
              <h3 className="settings-heading">通知</h3>
              <div className="setting-row">
                <div className="setting-info">
                  <Moon size={16} />
                  <div>
                    <div className="setting-name">勿扰模式</div>
                    <div className="setting-desc">暂停所有音效与系统通知</div>
                  </div>
                </div>
                <Toggle on={snap.dnd} onChange={() => void toggleDnd()} />
              </div>
              <div className="setting-row">
                <div className="setting-info">
                  <VolumeX size={16} />
                  <div>
                    <div className="setting-name">静音</div>
                    <div className="setting-desc">关闭音效，保留系统通知</div>
                  </div>
                </div>
                <Toggle on={snap.muted} onChange={() => void toggleMuted()} />
              </div>
              <div className="setting-row">
                <div className="setting-info">
                  <Music size={16} />
                  <div>
                    <div className="setting-name">提示音音色</div>
                    <div className="setting-desc">切换时自动试听一声</div>
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
                    <div className="setting-name">提示音音量</div>
                    <div className="setting-desc">拖动即时试听</div>
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
                  aria-label="提示音音量"
                />
              </div>
              <div className="setting-row">
                <div className="setting-info">
                  <Rocket size={16} />
                  <div>
                    <div className="setting-name">开机自启</div>
                    <div className="setting-desc">
                      {snap.autoLaunch ? '已开启，登录 Windows 后自动运行' : '登录后自动运行 Pupil'}
                    </div>
                  </div>
                </div>
                <Toggle on={snap.autoLaunch} onChange={() => void toggleAutoLaunch()} />
              </div>
            </section>

            {/* 数据接入 */}
            <section className="settings-section">
              <h3 className="settings-heading">数据接入</h3>
              {snap.adapters.map((a) => (
                <div className="setting-row" key={a.id}>
                  <div className="setting-info">
                    <span className={`adapter-dot ${a.running ? 'run' : ''} ${!a.available ? 'off' : ''}`} />
                    <div>
                      <div className="setting-name">{a.label}</div>
                      <div className="setting-desc">
                        {!a.available ? '未检测到数据源' : a.running ? '运行中' : a.enabled ? '已启用' : '已关闭'}
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

            {/* Claude Code Hooks */}
            <section className="settings-section">
              <h3 className="settings-heading">Claude Code Hooks</h3>
              <div className="setting-row">
                <div className="setting-info">
                  <div>
                    <div className="setting-name">
                      {snap.hooksInstalled ? '已安装' : '未安装'}
                    </div>
                    <div className="setting-desc">
                      写入 ~/.claude/settings.json，让 Claude Code 实时上报事件
                    </div>
                  </div>
                </div>
                <button
                  className={`hooks-btn ${snap.hooksInstalled ? 'danger' : ''}`}
                  disabled={busy === 'hooks'}
                  onClick={() => void hooksAction(!snap.hooksInstalled)}
                >
                  {busy === 'hooks' ? '处理中…' : snap.hooksInstalled ? '卸载' : '安装'}
                </button>
              </div>
            </section>

            {/* 更新 */}
            <section className="settings-section">
              <h3 className="settings-heading">更新</h3>
              <div className="setting-row">
                <div className="setting-info">
                  <Download size={16} />
                  <div>
                    <div className="setting-name">当前版本 v{snap.version}</div>
                    <div className="setting-desc">{updateDesc(update)}</div>
                  </div>
                </div>
                <button
                  className="hooks-btn"
                  disabled={updateBusy}
                  onClick={() => void checkUpdate()}
                >
                  {updateBusy ? '处理中…' : '检查更新'}
                </button>
              </div>
              {update?.status === 'available' && (
                <div className="setting-row">
                  <div className="setting-info">
                    <div>
                      <div className="setting-name">发现新版本 v{update.latestVersion}</div>
                      <div className="setting-desc">下载完成后自动打开安装向导</div>
                    </div>
                  </div>
                  <button className="hooks-btn" disabled={updateBusy} onClick={() => void downloadUpdate()}>
                    下载更新
                  </button>
                </div>
              )}
              {update?.status === 'available' && (
                <div className="setting-row">
                  <button
                    className="hooks-btn"
                    onClick={() => void window.pupil.openUpdatePage()}
                  >
                    在 GitHub 打开发布页
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
