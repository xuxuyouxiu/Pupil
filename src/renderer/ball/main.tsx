import React from 'react'
import ReactDOM from 'react-dom/client'
import { Ball } from './Ball'
import { setLocale, detectLocale } from '../../shared/i18n'
import './ball.css'

setLocale(detectLocale())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Ball />
  </React.StrictMode>
)
