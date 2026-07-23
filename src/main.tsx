import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The legacy layout rules remain available during the v2 migration; importing
// them here also ensures production builds include them (HTML links are not
// emitted by Vite for source-root assets).
import '../style.css'
import './index.css'
import App from './App'
import { installApiSecurity } from './lib/api-security'

installApiSecurity()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
