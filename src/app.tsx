import { useState } from 'preact/hooks'
import { UnlockScreen } from './components/UnlockScreen'
import { ChatApp } from './components/ChatApp'
import './app.css'

export function App() {
  const [token, setToken] = useState<string | null>(null)

  if (!token) {
    return <UnlockScreen onUnlocked={setToken} />
  }

  return <ChatApp token={token} onLock={() => setToken(null)} />
}
