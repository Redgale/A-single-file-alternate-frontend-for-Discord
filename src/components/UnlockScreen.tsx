import { useEffect, useState } from 'preact/hooks'
import { forgetToken, hasStoredToken, storeToken, unlock } from '../auth/vault'

interface Props {
  onUnlocked: (token: string) => void
}

export function UnlockScreen({ onUnlocked }: Props) {
  const [mode, setMode] = useState<'loading' | 'setup' | 'unlock'>('loading')
  const [token, setToken] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    hasStoredToken().then((exists) => setMode(exists ? 'unlock' : 'setup'))
  }, [])

  async function handleSetup(e: Event) {
    e.preventDefault()
    setError(null)
    if (passphrase.length < 8) return setError('Passphrase must be at least 8 characters')
    if (passphrase !== confirmPassphrase) return setError('Passphrases do not match')

    // Tokens copied from devtools localStorage come wrapped in quotes; strip
    // those plus any stray whitespace so a raw paste still works.
    const cleanToken = token.trim().replace(/^"|"$/g, '')
    if (!cleanToken) return setError('Paste your Discord token')

    setBusy(true)
    try {
      await storeToken(cleanToken, passphrase)
      onUnlocked(cleanToken)
    } finally {
      setBusy(false)
    }
  }

  async function handleUnlock(e: Event) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const t = await unlock(passphrase)
      onUnlocked(t)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock')
    } finally {
      setBusy(false)
    }
  }

  async function handleForget() {
    await forgetToken()
    setPassphrase('')
    setToken('')
    setError(null)
    setMode('setup')
  }

  if (mode === 'loading') return null

  return (
    <div class="unlock-screen">
      <div class="unlock-card">
        <h1>Unlock</h1>
        {mode === 'setup' ? (
          <form onSubmit={handleSetup}>
            <p class="hint">
              Paste your Discord token once. It will be encrypted with the passphrase you set
              below and stored only in this browser — it never leaves your device.
            </p>
            <label>
              Discord token
              <input
                type="password"
                autocomplete="off"
                value={token}
                onInput={(e) => setToken((e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              New passphrase
              <input
                type="password"
                value={passphrase}
                onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              Confirm passphrase
              <input
                type="password"
                value={confirmPassphrase}
                onInput={(e) => setConfirmPassphrase((e.target as HTMLInputElement).value)}
              />
            </label>
            {error && <p class="error">{error}</p>}
            <button type="submit" disabled={busy}>
              {busy ? 'Encrypting…' : 'Save & continue'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleUnlock}>
            <label>
              Passphrase
              <input
                type="password"
                autoFocus
                value={passphrase}
                onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
              />
            </label>
            {error && <p class="error">{error}</p>}
            <button type="submit" disabled={busy}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
            <button type="button" class="link-button" onClick={handleForget}>
              Use a different token
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
