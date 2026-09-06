# Custom Single-File Discord Frontend

A self-hosted, alternate Discord client that builds to a single static HTML file. It authenticates with your own Discord user token (no bot account) and talks directly to Discord's REST and gateway APIs, including full voice/video calling with Discord's mandatory DAVE end-to-end encryption.

> **Use at your own risk.** Automating a user account (as opposed to a bot account) is against Discord's Terms of Service and can get an account flagged or banned. This project is intended for personal, educational use with your own account — treat it accordingly.

## Features

- Guild + DM/group-DM chat: channel list (with permission-aware filtering), message history, sending messages (with attachments), typing indicators
- Real-time updates over the Discord gateway (messages, typing, presence, voice state)
- Guild voice channels **and** 1:1/group DM voice calls, with real Discord-protocol E2EE:
  - Discord's DAVE protocol (MLS / RFC 9420) implemented via Discord's actual open-source `libdave`/`mlspp` C++, compiled to WebAssembly
  - Per-frame audio/video encryption and decryption using WebRTC Encoded Transforms (Insertable Streams)
- Screen sharing (video capture, encoding, and encryption over the existing voice connection work; the "Go Live" stream-announce signaling so other clients can discover and watch a share is implemented but not yet verified against a real client)
- Encrypted local token storage: your token is encrypted at rest in IndexedDB (AES-GCM, key derived from a passphrase you choose via PBKDF2) and only ever held in plaintext in memory for the current tab

## Tech stack

- [Preact](https://preactjs.com/) + TypeScript, built with [Vite](https://vite.dev/)
- [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) to produce one self-contained `dist/index.html`
- A WebAssembly build of Discord's [`libdave`](https://github.com/discord/libdave) (bundled under `src/dave/wasm/`) for the DAVE/MLS E2EE handshake and frame crypto

## Getting started

```bash
npm install
npm run dev      # start the Vite dev server
npm run build    # type-check, then build dist/index.html
npm run preview  # serve the production build locally
```

On first load you'll be asked for your Discord token (paste it once) and a passphrase to encrypt it with. On subsequent loads you only need the passphrase to unlock.

## Project layout

```
src/
  app.tsx                    top-level unlock/chat routing
  auth/vault.ts               encrypted token storage (IndexedDB + AES-GCM)
  discord/
    rest.ts                   REST API client, model types, permission helpers
    gateway.ts                main Discord gateway (WebSocket) client
    voice.ts                  voice gateway client: WebRTC, SDP negotiation, DAVE wiring
  dave/
    DaveSessionManager.ts      JS-side MLS session/state machine driving the voice gateway's DAVE opcodes
    frameCrypto.ts             per-frame encrypt/decrypt helpers used by the WebRTC Encoded Transforms
    wasm/                      compiled libdave WASM module + generated TypeScript bindings
  components/                  UI: unlock screen, chat/call UI
```

## Security notes

- Your Discord token never leaves the browser except to talk directly to Discord's own API — there is no backend server.
- The token is encrypted with a passphrase-derived key before being written to IndexedDB; without the passphrase the stored record is unreadable.
- Voice/video media is end-to-end encrypted using Discord's own DAVE protocol, the same as official Discord clients.
