/**
 * Settings —— 设置视图（面板内，MVP 并入面板，独立窗口 P1）
 * 分区：通知 / 数据接入（adapter 开关）/ Claude Code Hooks 管理
 */
import { useCallback, useEffect, useState } from 'react'
import { SettingsSnapshot } from '../../shared/ipc-channels'
import { Moon, VolumeX, ChevronRight, X, Rocket } from '../shared/icons'

interface Props {
  onBack: () => void
}

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
      <header className="panel-top">
        <div className="settings-title">
          <button className="icon-btn" aria-label="返回" onClick={onBack}>
            <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <span>设置</span>
        </div>
        <button className="icon-btn" aria-label="关闭" onClick={onBack}>
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
          </>
        )}
      </div>
    </div>
  )
}
