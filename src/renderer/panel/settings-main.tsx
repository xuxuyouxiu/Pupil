import React from 'react'
import ReactDOM from 'react-dom/client'
import { Settings } from './Settings'
import './panel.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Settings onBack={() => window.close()} />
  </React.StrictMode>
)
