import React from 'react'
import ReactDOM from 'react-dom/client'
// 独立设置窗口入口（v0.3.4）：从 panel/ 目录拆出，避免与面板入口共享 chunk
// 导致渲染错误内容（v0.3.0~0.3.3 设置窗口实际渲染的是面板入口代码）
import { Settings } from '../panel/Settings'
import { setLocale, detectLocale } from '../../shared/i18n'
import '../panel/panel.css'

// v1.1.0 生效语言以主进程 config 为准（手动覆盖 > 系统跟随），就绪后再挂载
window.pupil.getLocale().then((l) => {
  setLocale(l ?? detectLocale())
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Settings onBack={() => window.close()} />
    </React.StrictMode>
  )
})
