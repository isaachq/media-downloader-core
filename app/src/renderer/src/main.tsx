import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {App} from './App'
import {installWebBridge} from './api'
import './styles.css'

await installWebBridge()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
