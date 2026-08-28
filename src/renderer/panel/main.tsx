import React from 'react'
import ReactDOM from 'react-dom/client'
import { Panel } from './Panel'
import { setLocale, detectLocale } from '../../shared/i18n'
import './panel.css'

setLocale(detectLocale())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>
)
