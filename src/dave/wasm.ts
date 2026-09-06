import DaveModuleFactory from './wasm/libdave.js'
import type { MainModule as DaveModule, Session, TransientKeys, SignaturePrivateKey } from './wasm/libdave'

export type { DaveModule, Session, TransientKeys, SignaturePrivateKey }
export { DaveModuleFactory }

let modulePromise: Promise<DaveModule> | null = null

/** The compiled libdave WASM module is ~2MB and only needed once voice is actually used. */
export function loadDaveModule(): Promise<DaveModule> {
  if (!modulePromise) {
    modulePromise = DaveModuleFactory() as Promise<DaveModule>
  }
  return modulePromise
}
