// Encryptor.Encrypt / Decryptor.Decrypt operate on raw WASM heap pointers
// (they're generated from a C++ API that writes in-place into a caller-owned
// buffer). These helpers do the malloc/copy-in/call/copy-out/free dance so
// the rest of the app only ever deals in Uint8Array.

import type { Encryptor, Decryptor } from './wasm/libdave'
import type { DaveModule } from './wasm'

export function encryptFrame(
  dave: DaveModule,
  encryptor: Encryptor,
  mediaType: { value: number },
  ssrc: number,
  frame: Uint8Array,
): Uint8Array {
  const maxSize = encryptor.GetMaxCiphertextByteSize(mediaType as never, frame.byteLength)
  const ptr = dave._malloc(maxSize)
  try {
    dave.HEAPU8.set(frame, ptr)
    const bytesWritten = encryptor.Encrypt(mediaType as never, ssrc, ptr, frame.byteLength, maxSize)
    if (bytesWritten === 0) return frame // encryption failed/not ready — pass through unchanged
    return dave.HEAPU8.slice(ptr, ptr + bytesWritten)
  } finally {
    dave._free(ptr)
  }
}

export function decryptFrame(
  dave: DaveModule,
  decryptor: Decryptor,
  mediaType: { value: number },
  frame: Uint8Array,
): Uint8Array | null {
  const maxSize = decryptor.GetMaxPlaintextByteSize(mediaType as never, frame.byteLength)
  const capacity = Math.max(maxSize, frame.byteLength)
  const ptr = dave._malloc(capacity)
  try {
    dave.HEAPU8.set(frame, ptr)
    const bytesWritten = decryptor.Decrypt(mediaType as never, ptr, frame.byteLength, capacity)
    if (bytesWritten === 0) return null
    return dave.HEAPU8.slice(ptr, ptr + bytesWritten)
  } finally {
    dave._free(ptr)
  }
}
