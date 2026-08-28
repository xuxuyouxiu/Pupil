import React from 'react'
import ReactDOM from 'react-dom/client'
// 独立设置窗口入口（v0.3.4）：从 panel/ 目录拆出，避免与面板入口共享 chunk
// 导致渲染错误内容（v0.3.0~0.3.3 设置窗口实际渲染的是面板入口代码）
import { Settings } from '../panel/Settings'
import { setLocale, detectLocale } from '../../shared/i18n'
import '../panel/panel.css'

setLocale(detectLocale())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Settings onBack={() => window.close()} />
  </React.StrictMode>
)
