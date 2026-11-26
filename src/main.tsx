import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { UiProvider } from './components/ui'
import { initTheme } from './lib/theme'
import './styles.css'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>,
)
