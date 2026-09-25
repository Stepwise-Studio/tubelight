import { supabase } from '@/lib/supabase'

const BASE = process.env.EXPO_PUBLIC_AGENT_URL ?? 'http://localhost:8787'

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

/** Calls agent-service as the signed-in user. Throws ApiError with a human-readable message. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const headers = new Headers(init.headers)
  if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`)
  if (init.json !== undefined) headers.set('Content-Type', 'application/json')

  let res: Response
  try {
    res = await fetch(BASE + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  } catch {
    throw new ApiError('Can’t reach the teammate service. Check it’s running and on the same network.', 0)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(body?.detail ?? `Request failed (${res.status})`, res.status)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}
