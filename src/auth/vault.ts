// Encrypted client-side storage for the Discord user token.
// The token is encrypted at rest (AES-GCM, key derived from a local
// passphrase via PBKDF2) and only ever held in plaintext in memory,
// for the lifetime of the current tab.

import { openDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'discord-frontend-vault'
const STORE_NAME = 'vault'
const RECORD_KEY = 'token'
const PBKDF2_ITERATIONS = 250_000

interface VaultRecord {
  salt: number[]
  iv: number[]
  ciphertext: number[]
}

let dbPromise: Promise<IDBPDatabase> | null = null
function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE_NAME)
      },
    })
  }
  return dbPromise
}

async function deriveKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** In-memory only. Never persisted, never sent over the network. */
let unlockedToken: string | null = null

export function getUnlockedToken(): string | null {
  return unlockedToken
}

export function lock(): void {
  unlockedToken = null
}

export async function hasStoredToken(): Promise<boolean> {
  const db = await getDB()
  return (await db.get(STORE_NAME, RECORD_KEY)) !== undefined
}

/** First-time setup: encrypts and stores `token` under `passphrase`. */
export async function storeToken(token: string, passphrase: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token),
  )

  const record: VaultRecord = {
    salt: Array.from(salt),
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  }

  const db = await getDB()
  await db.put(STORE_NAME, record, RECORD_KEY)
  unlockedToken = token
}

/** Decrypts the stored token with `passphrase` and holds it in memory. Throws on wrong passphrase. */
export async function unlock(passphrase: string): Promise<string> {
  const db = await getDB()
  const record = (await db.get(STORE_NAME, RECORD_KEY)) as VaultRecord | undefined
  if (!record) throw new Error('No token stored yet')

  const salt = new Uint8Array(record.salt)
  const iv = new Uint8Array(record.iv)
  const key = await deriveKey(passphrase, salt)

  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      new Uint8Array(record.ciphertext),
    )
  } catch {
    // AES-GCM authentication failure means wrong passphrase (or tampered data).
    throw new Error('Incorrect passphrase')
  }

  const token = new TextDecoder().decode(plaintext)
  unlockedToken = token
  return token
}

/** Wipes the stored, encrypted token entirely (does not affect the live Discord session). */
export async function forgetToken(): Promise<void> {
  const db = await getDB()
  await db.delete(STORE_NAME, RECORD_KEY)
  unlockedToken = null
}
