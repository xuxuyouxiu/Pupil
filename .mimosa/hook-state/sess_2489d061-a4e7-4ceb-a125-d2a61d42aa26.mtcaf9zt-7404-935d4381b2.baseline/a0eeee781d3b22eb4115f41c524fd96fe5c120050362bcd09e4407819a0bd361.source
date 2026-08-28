/**
 * 开机自启 —— app.setLoginItemSettings 封装（Windows：注册表 Run 键，OpenAtLogin）
 * - dev 模式（electron.exe 直跑）不注册登录项：Electron 登录启动的是裸 electron.exe 而非应用本身，
 *   注册了也只会打开一个空 Electron 壳；偏好仍持久化到 config，打包版安装后即生效。
 * - openAsHidden 暂不支持：球窗口 show 无 hidden 参数，MVP 自启即显示。
 */
import { app } from 'electron'
import { ConfigStore } from './config'

export class AutoLaunch {
  constructor(private config: ConfigStore) {}

  /** 打包版才真正写登录项 */
  private get canRegister(): boolean {
    return app.isPackaged
  }

  /** 当前是否生效（打包版读系统真实状态，dev 读偏好） */
  isEnabled(): boolean {
    if (this.canRegister) {
      const s = app.getLoginItemSettings()
      return s.openAtLogin
    }
    return this.config.get('autoLaunch') ?? false
  }

  /** 设置自启并持久化偏好；返回是否生效 */
  set(enabled: boolean): boolean {
    this.config.set('autoLaunch', enabled)
    if (this.canRegister) {
      app.setLoginItemSettings({ openAtLogin: enabled, args: [] })
    }
    return this.isEnabled()
  }
}
