import type { AppClient } from '@lingshell/shared'
import { createIpcTransport } from './transports/IpcTransport.js'
import { HttpTransport } from './transports/HttpTransport.js'

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { electronAPI?: unknown }).electronAPI
}

export function createClient(): AppClient {
  if (isElectron()) return createIpcTransport()
  return new HttpTransport(import.meta.env.VITE_API_URL ?? 'http://localhost:3000')
}
