// Picking a project's GitHub repo by name (from the user's own GitHub connection), and what Tubelight knows about it.
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Github01Icon } from '@hugeicons/core-free-icons'

import { BrandTile } from '@/components/brand-mark'
import { api } from '@/lib/api'
import { connectApp, useConnections } from '@/lib/catalog'
import { ago } from '@/lib/format'
import { Button, Icon, PickerField, Text, type PickerOption } from '@/ui'

interface RepoOption { value: string; label: string; sets?: Record<string, string> }

let reposCache: RepoOption[] | null = null

/** The user's GitHub repos (owner/name), or why they can't be listed. */
export function useGithubRepos() {
  const { connections } = useConnections()
  const connected = connections?.some((c) => c.toolkit === 'GITHUB' && c.connected) ?? null
  const [repos, setRepos] = useState<RepoOption[] | null>(reposCache)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!connected || reposCache) return
    let live = true
    api<RepoOption[]>('/apps/GITHUB/choices/repo').then(
      (l) => { reposCache = l; if (live) setRepos(l) },
      (e: Error) => { if (live) setError(e.message) },
    )
    return () => { live = false }
  }, [connected])
  return { connected, repos, error }
}

/** A field listing the user's GitHub repos ("No repo" first). Offers to connect GitHub when it isn't. `value` is
 * "owner/name" or null. */
export function RepoPicker({ value, onChange }: { value: string | null; onChange: (repo: string | null) => void }) {
  const { connected, repos, error } = useGithubRepos()
  if (connected === false) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <BrandTile toolkit="GITHUB" size={32} />
        <Text variant="caption" color="ink3" style={{ flex: 1 }}>Connect GitHub to pick one of your repos. Teammates then read it and keep up with its changes.</Text>
        <Button label="Connect" size="sm" variant="soft" onPress={() => connectApp('GITHUB', 'GitHub')} />
      </View>
    )
  }
  const options: PickerOption[] = [
    { value: '', title: 'No repo', subtitle: 'This project isn’t about code' },
    ...(repos ?? []).map((r) => {
      const [owner, name] = r.label.split('/')
      return { value: r.label, title: name, subtitle: owner, group: 'Your repos', keywords: r.label,
        leading: <View style={{ width: 32, alignItems: 'center' }}><Icon icon={Github01Icon} size={20} color="ink2" /></View> }
    }),
  ]
  // A repo set earlier that the list doesn't show (another account's, or the list failed): keep it choosable.
  if (value && !options.some((o) => o.value === value)) options.splice(1, 0, { value, title: value.split('/')[1] ?? value, subtitle: value.split('/')[0] })
  return (
    <View style={{ gap: 6 }}>
      <PickerField
        label="Repository"
        value={value ?? ''}
        options={options}
        onChange={(v) => onChange(v || null)}
        placeholder={repos === null && !error ? 'Loading your repos…' : 'Pick a repo'}
        intro="Teammates in this project read the repo, keep up with new commits and can search its code."
      />
      {error && <Text variant="footnote" color="ink3">Couldn’t list your repos right now ({error}).</Text>}
    </View>
  )
}

export interface RepoState {
  repo: string | null
  status: 'checking' | 'reading' | 'ready' | 'error'
  progress?: number
  current?: string
  files?: number
  sha?: string
  branch?: string
  indexed_at?: string
  checked_at?: string
  error?: string | null
}
export interface RepoKnowledge {
  repo: string | null
  state: RepoState | null
  brief: string
  generated: string
  edited: boolean
  /** The user's own version of the brief, if they wrote one. */
  mine: string
  notes: { text: string; by: string; at: string }[]
  areas: { name: string; summary: string; files: number }[]
  log: { at: string; from: string; to: string; commits: { sha: string; message: string; author: string }[] }[]
}

/** The project's repo knowledge; checks back every few seconds while it's being read. */
export function useRepoKnowledge(projectId: string) {
  const [k, setK] = useState<RepoKnowledge | null>(null)
  const [stamp, setStamp] = useState(0)
  const reload = () => setStamp((n) => n + 1)
  useEffect(() => {
    let live = true
    api<RepoKnowledge>(`/projects/${projectId}/repo`).then((r) => { if (live) setK(r) }, () => {})
    return () => { live = false }
  }, [projectId, stamp])
  const busy = k?.state?.status === 'reading' || k?.state?.status === 'checking'
  useEffect(() => {
    if (!busy) return
    const t = setTimeout(reload, 3000)
    return () => clearTimeout(t)
  }, [busy, k])
  return { k, reload, setK }
}

/** One line on where the reading stands: progress while reading, files and freshness when done, the error otherwise. */
export function repoStatusLine(s: RepoState | null | undefined): { text: string; tone: 'ink3' | 'danger' | 'tube' } {
  if (!s) return { text: 'Not read yet.', tone: 'ink3' }
  if (s.status === 'checking') return { text: 'Checking for new commits…', tone: 'tube' }
  if (s.status === 'reading') {
    const where = s.current === 'brief' ? 'writing the brief' : s.current ? `reading ${s.current}` : 'downloading'
    return { text: `Reading the code: ${where} (${s.progress ?? 0}%)`, tone: 'tube' }
  }
  if (s.status === 'error') return { text: `Couldn’t read it: ${s.error ?? 'unknown error'}`, tone: 'danger' }
  return {
    text: [`${s.files ?? 0} files`, s.branch, s.sha && `commit ${s.sha.slice(0, 7)}`, s.indexed_at && `updated ${ago(s.indexed_at).toLowerCase()}`]
      .filter(Boolean).join(' · '),
    tone: 'ink3',
  }
}
