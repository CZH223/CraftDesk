import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 节点')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
