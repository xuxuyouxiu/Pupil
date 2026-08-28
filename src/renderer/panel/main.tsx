import React from 'react'
import ReactDOM from 'react-dom/client'
import { Panel } from './Panel'
import { setLocale, detectLocale } from '../../shared/i18n'
import './panel.css'

// v1.1.0 生效语言以主进程 config 为准（手动覆盖 > 系统跟随），就绪后再挂载
window.pupil.getLocale().then((l) => {
  setLocale(l ?? detectLocale())
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Panel />
    </React.StrictMode>
  )
})
