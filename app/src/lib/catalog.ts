// Engine-side catalogues (templates, models, connections) plus the fixed choices the editors offer.
import * as Crypto from 'expo-crypto'
import { useCallback, useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { FALLBACK_TEMPLATES } from '@/lib/templates'
import type { BotShape, Teammate } from '@/lib/types'

export interface Template {
  role: string
  name: string
  handle: string
  bio: string
  system_prompt: string
  allowed_toolkits: string[]
  avatar_shape: BotShape
  color: string
}

export interface Model { id: string; name: string; provider: string; context_length: number }

export interface Connection {
  toolkit: string
  name: string
  connected: boolean
  status: string // unavailable | not_connected | active | initiated | expired | failed ...
  account?: string
}

export const DEFAULT_MODEL = 'groq:openai/gpt-oss-120b'
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/
export const REPO_RE = /^https?:\/\/\S+\.\S+/

export const SHAPES: BotShape[] = [
  'clover', 'flower', 'star', 'ghost', 'mech', 'circle', 'hexagon', 'square', 'triangle',
  'blob', 'drop', 'droid', 'alien', 'cat', 'cloud', 'pill', 'pebble', 'puddle',
]

/** Mid-light pastels: readable faces on zinc-950 and on white. */
export const COLORS = [
  { value: '#8b9cf7', name: 'Periwinkle' },
  { value: '#8bd4f7', name: 'Sky' },
  { value: '#8bf7c9', name: 'Mint' },
  { value: '#c9e98b', name: 'Lime' },
  { value: '#f7e08b', name: 'Butter' },
  { value: '#f7b58b', name: 'Peach' },
  { value: '#f79a9a', name: 'Coral' },
  { value: '#f78bc4', name: 'Pink' },
]

/** Toolkits a teammate can be given. Order matches the Connections screen. */
export const TOOLKITS = ['GMAIL', 'GITHUB', 'LINEAR', 'NOTION'] as const
export const TOOLKIT_NAMES: Record<string, string> = {
  GMAIL: 'Gmail', GITHUB: 'GitHub', LINEAR: 'Linear', NOTION: 'Notion', LINKEDIN: 'LinkedIn', SLACK: 'Slack',
  GOOGLECALENDAR: 'Google Calendar', GOOGLEDRIVE: 'Google Drive', TWITTER: 'X', COMPOSIO: 'Composio',
}
export const toolkitName = (t: string) => TOOLKIT_NAMES[t] ?? t.charAt(0) + t.slice(1).toLowerCase()

const ROLE_NAMES: Record<string, string> = { developer: 'Developer', tester: 'QA engineer', social: 'Social media lead', email: 'Inbox chief of staff' }
export const roleName = (key: string) => ROLE_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1)

export const PROVIDERS: Record<string, string> = { groq: 'Groq', openrouter: 'OpenRouter', gemini: 'Gemini', mistral: 'Mistral' }

/** "groq:openai/gpt-oss-120b" → "GPT OSS 120B". Uses the service's name when we have it. */
export function modelName(id: string, models?: Model[] | null) {
  const known = models?.find((m) => m.id === id)
  if (known) return known.name.replace(/^[^:]+:\s*/, '').replace(/^[^/\s]+\//, '').replace(/\s*\(free\)\s*$/i, '').replace(/\s+/g, ' ').trim()
  const slug = id.split('/').pop()!.split(':').filter((p) => p !== 'free').pop() ?? id
  return slug.split('-').map((w) =>
    /^\d/.test(w) || w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export const modelProvider = (id: string) => {
  const p = id.includes(':') ? id.slice(0, id.indexOf(':')) : 'openrouter'
  return PROVIDERS[p] ? p : 'openrouter'
}

export const contextLabel = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`) + ' context'

export function fromTemplate(t: Template): Pick<Teammate, 'name' | 'handle' | 'role' | 'bio' | 'system_prompt' | 'model' | 'allowed_toolkits' | 'avatar_shape' | 'color'> {
  return {
    name: t.name, handle: t.handle, role: roleName(t.role), bio: t.bio, system_prompt: t.system_prompt,
    model: DEFAULT_MODEL, allowed_toolkits: t.allowed_toolkits, avatar_shape: t.avatar_shape, color: t.color,
  }
}

// ponytail: module-level caches; templates and models don't change while the app runs.
let templatesCache: Template[] | null = null
let modelsCache: Model[] | null = null

/** GET /templates, falling back to the built-in copy. Never empty. */
export function useTemplates() {
  const [list, setList] = useState<Template[]>(templatesCache ?? FALLBACK_TEMPLATES)
  useEffect(() => {
    if (templatesCache) return
    api<Template[]>('/templates').then((t) => { if (t?.length) { templatesCache = t; setList(t) } }).catch(() => {})
  }, [])
  return list
}

/** GET /models. `null` while loading; `error` when the service is unreachable. */
export function useModels() {
  const [list, setList] = useState<Model[] | null>(modelsCache)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (modelsCache) return
    api<Model[]>('/models').then((m) => { modelsCache = m; setList(m) }).catch((e: Error) => setError(e.message))
  }, [])
  return { models: list, error }
}

/** GET /connections, reloadable. */
export function useConnections() {
  const [list, setList] = useState<Connection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const apply = useCallback((p: Promise<Connection[]>) =>
    p.then((l) => { setList(l); setError(null) }, (e: Error) => setError(e.message)), [])
  const reload = useCallback(() => apply(api<Connection[]>('/connections')), [apply])
  useEffect(() => { apply(api<Connection[]>('/connections')) }, [apply])
  return { connections: list, error, reload }
}

export const randomHex = (bytes: number) =>
  Array.from(Crypto.getRandomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('')

/** A handle that isn't taken yet: dev, dev-2, dev-3… */
export function freeHandle(base: string, taken: Teammate[]) {
  const used = new Set(taken.map((t) => t.handle))
  if (!used.has(base)) return base
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`
}
