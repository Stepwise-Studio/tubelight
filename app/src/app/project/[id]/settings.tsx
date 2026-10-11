import * as Clipboard from 'expo-clipboard'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { KeyboardAwareScrollView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Add01Icon, AlertCircleIcon, BookOpen01Icon, Cancel01Icon, Delete02Icon, Mail01Icon, MinusSignIcon,
  SourceCodeIcon, UserAdd01Icon, UserRemove01Icon, WebhookIcon,
} from '@hugeicons/core-free-icons'

import { CodeBlock, ColorSwatches, FormSection, GroupIconPicker, RowWithAction, TeammateToggles } from '@/components/form-bits'
import { MemoryList } from '@/components/memory-list'
import { AutomationRows } from '@/components/automation-rows'
import { RepoPicker, repoStatusLine, useRepoKnowledge } from '@/components/repo-picker'
import { ScreenHeader } from '@/components/screen-header'
import { api } from '@/lib/api'
import { COLORS } from '@/lib/catalog'
import { useAutomations } from '@/lib/automations'
import { supabase } from '@/lib/supabase'
import type { EventRule, Project, Teammate } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import {
  AvatarStack, Button, Chip, Divider, EmptyState, Icon, IconButton, ListRow, NumberPop, Sheet, Skeleton, Surface,
  TeammateAvatar, Text, TextField, Toggle, confirm, haptic, toast, type IconSvgElement,
} from '@/ui'

const AGENT_URL = process.env.EXPO_PUBLIC_AGENT_URL ?? 'http://localhost:8787'

const TYPES: { value: string; label: string; icon: IconSvgElement }[] = [
  { value: 'error', label: 'Error', icon: AlertCircleIcon },
  { value: 'email', label: 'Email', icon: Mail01Icon },
  { value: 'github_issue', label: 'GitHub issue', icon: SourceCodeIcon },
  { value: 'custom', label: 'Custom', icon: WebhookIcon },
]
const typeOf = (v: string) => TYPES.find((t) => t.value === v) ?? { value: v, label: v.replace(/_/g, ' '), icon: WebhookIcon }

const copy = async (value: string, what: string) => {
  await Clipboard.setStringAsync(value)
  haptic.light()
  toast({ title: `${what} copied` })
}

export default function ProjectSettings() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const ws = useWorkspace()
  const p = ws.project(id)
  if (!p) {
    return (
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <ScreenHeader title="Project settings" />
        {ws.loading ? (
          <View style={{ padding: 20, gap: 12 }} accessible accessibilityLabel="Loading"><Skeleton width="60%" height={16} /><Skeleton width="90%" /><Skeleton width="40%" /></View>
        ) : (
          <EmptyState title="This project isn’t here anymore" body="It may have been deleted on another device." action={<Button label="Back to chats" variant="soft" onPress={() => router.replace('/')} />} />
        )}
      </View>
    )
  }
  return <Settings key={p.id} p={p} />
}

function Settings({ p }: { p: Project }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const insets = useSafeAreaInsets()
  const members = ws.membersOf(p.id)
  const working = new Set(members.filter((m) => ws.isWorking(m.id)).map((m) => m.id))

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${p.name}?`,
      body: 'This deletes the project chat, its messages and its event rules. Teammates stay on your team. It can’t be undone.',
      confirmLabel: 'Delete project',
      destructive: true,
    })
    if (!ok) return
    const { error } = await supabase.from('projects').delete().eq('id', p.id)
    if (error) { toast({ title: 'Unable to delete the project', body: 'Check your connection and try again.', tone: 'error' }); return }
    await ws.refresh()
    router.dismissTo('/')
    toast({ title: `${p.name} was deleted` })
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader
        title={p.name}
        subtitle="Project settings"
        right={members.length > 0 ? <View style={{ paddingRight: 8 }}><AvatarStack teammates={members} size={26} max={4} working={working} /></View> : null}
      />
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 40 }}>
        <Details p={p} />
        <Repository p={p} />
        <Members p={p} members={members} />
        <Computers p={p} />
        <FormSection title="Memory" hint="Facts every member knows about this project.">
          <MemoryList scope="project" id={p.id} owner={p.name} />
        </FormSection>
        <Automations p={p} members={members} />
        <Rules p={p} members={members} />
        <FormSection title="Delete">
          <Text variant="caption" color="ink3">Deleting the project removes its chat and rules. Your teammates stay.</Text>
          <Button label="Delete project" variant="outline" icon={Delete02Icon} onPress={remove} />
        </FormSection>
      </KeyboardAwareScrollView>
    </View>
  )
}

// ------------------------------------------------------------------ computers

// Lend one of your linked computers to the project: its teammates get full access to it (agent: computers.for_project).
function Computers({ p }: { p: Project }) {
  const [list, setList] = useState<{ id: string; name: string; online: boolean; full: boolean }[] | null>(null)
  const [lent, setLent] = useState<string[]>([])
  useEffect(() => {
    api<{ computers: { id: string; name: string; online: boolean; full: boolean }[] }>('/computers').then((d) => setList(d.computers), () => setList([]))
    api<{ computers: string[] }>(`/projects/${p.id}/computers`).then((d) => setLent(d.computers), () => {})
  }, [p.id])
  if (!list?.length) return null
  const lend = async (id: string, on: boolean) => {
    const before = lent
    setLent(on ? [id] : [])
    try {
      const d = await api<{ computers: string[] }>(`/projects/${p.id}/computers`, { method: 'PUT', json: { computers: on ? [id] : [] } })
      setLent(d.computers)
      haptic.success()
    } catch (e) {
      setLent(before)
      toast({ title: 'Unable to change that', body: (e as Error).message, tone: 'error' })
    }
  }
  return (
    <FormSection title="Computer" hint="Teammates here can work on the computer you lend: read and write files, run commands, start projects. Changes still ask you first unless the computer is set to run freely.">
      <View style={{ gap: 12 }}>
        {list.map((m) => (
          <Toggle key={m.id} value={lent.includes(m.id)} onChange={(v) => lend(m.id, v)} label={m.name}
            description={!m.full ? 'Full access is off on the computer: turn it on in Tubelight there' : m.online ? 'Online' : 'Offline right now'} />
        ))}
      </View>
    </FormSection>
  )
}

// ------------------------------------------------------------------ details

function Repository({ p }: { p: Project }) {
  const ws = useWorkspace()
  const { k, reload, setK } = useRepoKnowledge(p.id)
  const [saving, setSaving] = useState(false)
  const pick = async (repo: string | null) => {
    if ((repo ?? null) === (k?.repo ?? null)) return
    if (k?.repo && !repo && !await confirm({ title: 'Remove the repo?', body: `Teammates forget what they learned about ${k.repo}.`, confirmLabel: 'Remove', destructive: true })) return
    setSaving(true)
    try {
      await api(`/projects/${p.id}/repo`, { method: 'PUT', json: { repo } })
      setK((x) => (x ? { ...x, repo, state: repo ? { repo, status: 'checking', progress: 0 } : null } : x))
      await ws.refresh()
      haptic.success()
      if (repo) toast({ title: 'Reading the repo', body: 'Teammates here will know it in a few minutes.' })
      reload()
    } catch (e) {
      toast({ title: 'Unable to change the repo', body: (e as Error).message, tone: 'error' })
    } finally { setSaving(false) }
  }
  const status = repoStatusLine(k?.state)
  return (
    <FormSection title="Repository" hint={k?.repo ? undefined : 'Pick a repo and every teammate here learns the code and keeps up with its changes.'}>
      <RepoPicker value={k?.repo ?? null} onChange={pick} />
      {k?.repo && (
        <>
          <Text variant="footnote" color={status.tone} accessibilityLiveRegion="polite">{saving ? 'Saving…' : status.text}</Text>
          <Surface style={{ overflow: 'hidden' }}>
            <ListRow title="Repo knowledge" subtitle="The brief teammates read, its areas and recent changes" icon={BookOpen01Icon} chevron
              onPress={() => router.push({ pathname: '/project/[id]/repo', params: { id: p.id } })} />
          </Surface>
        </>
      )}
    </FormSection>
  )
}

function Details({ p }: { p: Project }) {
  const ws = useWorkspace()
  const [name, setName] = useState(p.name)
  const [description, setDescription] = useState(p.description)
  const [color, setColor] = useState(p.color)
  const [icon, setIcon] = useState(p.icon)
  const [errors, setErrors] = useState<{ name?: string }>({})
  const [saving, setSaving] = useState(false)
  const dirty = name !== p.name || description !== p.description || color !== p.color || icon !== p.icon

  const save = async () => {
    const e: typeof errors = {}
    if (!name.trim()) e.name = 'Give the project a name.'
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    const { error } = await supabase.from('projects')
      .update({ name: name.trim(), description: description.trim(), color, icon, updated_at: new Date().toISOString() })
      .eq('id', p.id)
    if (!error) await ws.refresh()
    setSaving(false)
    if (error) toast({ title: 'Unable to save the project', body: 'Check your connection and try again.', tone: 'error' })
    else { haptic.success(); toast({ title: 'Project saved', tone: 'success' }) }
  }

  return (
    <FormSection title="Details">
      <TextField label="Name" value={name} onChangeText={setName} error={errors.name} maxLength={60} />
      <TextField label="Description" value={description} onChangeText={setDescription} placeholder="What the team is working on" multiline showCount maxLength={280} />
      <ColorSwatches colors={COLORS} value={color} onChange={setColor} />
      <GroupIconPicker color={color} value={icon} onChange={setIcon} />
      {dirty && (
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
          <Button label="Discard" variant="ghost" onPress={() => { setName(p.name); setDescription(p.description); setColor(p.color); setIcon(p.icon); setErrors({}) }} />
          <Button label="Save details" loading={saving} onPress={save} />
        </View>
      )}
    </FormSection>
  )
}

// ------------------------------------------------------------------ members

function Members({ p, members }: { p: Project; members: Teammate[] }) {
  const ws = useWorkspace()
  const [adding, setAdding] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const others = ws.teammates.filter((t) => !members.some((m) => m.id === t.id))

  const removeMember = async (t: Teammate) => {
    const ok = await confirm({ title: `Remove ${t.name} from ${p.name}?`, body: `${t.name} stops seeing this chat. Their DMs and memory stay.`, confirmLabel: 'Remove from project' })
    if (!ok) return
    const { error } = await supabase.from('project_members').delete().eq('project_id', p.id).eq('teammate_id', t.id)
    if (error) toast({ title: `Unable to remove ${t.name}`, tone: 'error', body: 'Check your connection and try again.' })
    else await ws.refresh()
  }

  const addPicked = async () => {
    const { error } = await supabase.from('project_members').insert([...picked].map((teammate_id) => ({ project_id: p.id, teammate_id })))
    if (error) { toast({ title: 'Unable to add members', body: 'Check your connection and try again.', tone: 'error' }); return }
    haptic.success()
    await ws.refresh()
    setAdding(false)
    setPicked(new Set())
  }

  return (
    <FormSection
      title="Members"
      action={others.length > 0 ? <Button label="Add" size="sm" variant="soft" icon={UserAdd01Icon} onPress={() => setAdding(true)} /> : undefined}
    >
      {members.length === 0 ? (
        <Text variant="caption" color="ink3">No one’s in this project yet. Add teammates so they can reply here.</Text>
      ) : (
        <Surface style={{ overflow: 'hidden' }}>
          {members.map((t, i) => (
            <View key={t.id}>
              {i > 0 && <Divider inset={64} />}
              <RowWithAction
                onPress={() => router.push({ pathname: '/teammate/[id]', params: { id: t.id } })}
                accessibilityLabel={`${t.name}, ${t.role}`}
                accessibilityHint="Opens their profile"
                action={<IconButton icon={UserRemove01Icon} iconSize={18} accessibilityLabel={`Remove ${t.name} from the project`} onPress={() => removeMember(t)} />}
              >
                <TeammateAvatar teammate={t} size={40} interactive={false} state={ws.isWorking(t.id) ? 'working' : 'default'} />
                <RowText title={t.name} subtitle={`@${t.handle} · ${t.role}`} />
              </RowWithAction>
            </View>
          ))}
        </Surface>
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title={`Add to ${p.name}`}>
        <View style={{ paddingHorizontal: 16, gap: 16 }}>
          <TeammateToggles teammates={others} selected={picked} onToggle={(tid) => setPicked((s) => { const n = new Set(s); if (n.has(tid)) n.delete(tid); else n.add(tid); return n })} />
          <Button label={picked.size ? `Add ${picked.size} ${picked.size === 1 ? 'teammate' : 'teammates'}` : 'Pick teammates to add'} fullWidth size="lg" disabled={!picked.size} onPress={addPicked} />
        </View>
      </Sheet>
    </FormSection>
  )
}

// ------------------------------------------------------------------ event rules + webhook

interface RuleDraft {
  id?: string
  name: string
  type: string // one of TYPES, or a custom type name
  custom: string
  match: { k: string; v: string }[]
  teammate_id: string | null
  instructions: string
  max_per_hour: number
  enabled: boolean
}

const blankRule = (teammateId: string | null): RuleDraft => ({
  name: '', type: 'error', custom: '', match: [], teammate_id: teammateId, instructions: '', max_per_hour: 6, enabled: true,
})

function toDraft(r: EventRule): RuleDraft {
  const known = TYPES.some((t) => t.value === r.event_type && t.value !== 'custom')
  const rest = r.match as Record<string, string>
  return {
    id: r.id, name: r.name, type: known ? r.event_type : 'custom', custom: known ? '' : r.event_type,
    match: Object.entries(rest).map(([k, v]) => ({ k, v: String(v) })),
    teammate_id: r.teammate_id, instructions: r.instructions, max_per_hour: r.max_per_hour, enabled: r.enabled,
  }
}

function ruleSummary(r: EventRule, name: (id: string) => string | undefined) {
  const filters = Object.entries(r.match)
  const where = filters.length ? ` where ${filters[0][0]} is ${String(filters[0][1])}${filters.length > 1 ? ` and ${filters.length - 1} more` : ''}` : ''
  const what = typeOf(r.event_type).label + where
  return `${what} · ${name(r.teammate_id) ?? 'Removed teammate'} · up to ${r.max_per_hour} an hour`
}

function Automations({ p, members }: { p: Project; members: Teammate[] }) {
  const autos = useAutomations()
  const here = autos.list?.filter((a) => a.thread_id === `proj:${p.id}`) ?? null
  return (
    <FormSection
      title="Automations"
      hint={here?.length ? 'What members do here on their own.' : undefined}
      action={<Button label="New" size="sm" variant="soft" icon={Add01Icon} disabled={!members.length} onPress={() => router.push({ pathname: '/automation/[id]', params: { id: 'new', thread: `proj:${p.id}` } })} />}
    >
      {here === null ? (
        <Surface padding={16} style={{ gap: 10 }}><Skeleton width="70%" /><Skeleton width="45%" /></Surface>
      ) : here.length === 0 ? (
        <Text variant="caption" color="ink3">None yet. Ask a member in the chat, like “every Friday at 5, sum up the week”.</Text>
      ) : (
        <AutomationRows items={here} show="who" onToggle={autos.toggle} />
      )}
    </FormSection>
  )
}

function Rules({ p, members }: { p: Project; members: Teammate[] }) {
  const ws = useWorkspace()
  const [rules, setRules] = useState<EventRule[] | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [editing, setEditing] = useState<RuleDraft | null>(null)
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState(0) // remounts the sheet per edit, so old errors don't linger

  const load = useCallback(() => Promise.all([
    // Webhook rules only: schedules and app events are automations (the section above).
    supabase.from('event_rules').select('*').eq('project_id', p.id).not('event_type', 'in', '(schedule,app)').order('created_at'),
    supabase.from('profiles').select('webhook_token').single(),
  ]).then(([r, prof]) => {
    setRules((r.data ?? []) as EventRule[])
    setToken((prof.data as { webhook_token: string } | null)?.webhook_token ?? null)
  }), [p.id])
  useEffect(() => { load() }, [load])

  const edit = (d: RuleDraft) => { setEditing(d); setSession((n) => n + 1); setOpen(true) }

  const setEnabled = async (r: EventRule, enabled: boolean) => {
    setRules((l) => l?.map((x) => (x.id === r.id ? { ...x, enabled } : x)) ?? l)
    // Through the service, so the chat gets its paused/resumed capsule like the Scheduled sheet's toggle.
    try { await api(`/automations/${r.id}`, { method: 'PATCH', json: { enabled } }) } catch {
      toast({ title: 'Unable to update the rule', tone: 'error', body: 'Check your connection and try again.' }); load()
    }
  }

  const url = token ? `${AGENT_URL}/events/${token}` : null
  const sample = rules?.[0]
  const payload = { ...(sample ? sample.match : {}), message: 'TypeError: Cannot read properties of undefined (reading \'id\')' }
  const curl = url && `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ type: sample?.event_type ?? 'error', source: 'sentry', payload })}'`

  return (
    <>
      <FormSection
        title="Event rules"
        hint="Wake a teammate when something happens, and they post here on their own."
        action={<Button label="New rule" size="sm" variant="soft" icon={Add01Icon} disabled={!members.length} onPress={() => edit(blankRule(members[0]?.id ?? null))} />}
      >
        {rules === null ? (
          <Surface padding={16} style={{ gap: 10 }}><Skeleton width="70%" /><Skeleton width="45%" /></Surface>
        ) : rules.length === 0 ? (
          <Text variant="caption" color="ink3">
            {members.length ? 'No rules yet. For example: when an error comes in, Tess reproduces it and reports back.' : 'Add a member first, then give them a rule.'}
          </Text>
        ) : (
          <Surface style={{ overflow: 'hidden' }}>
            {rules.map((r, i) => (
              <View key={r.id}>
                {i > 0 && <Divider inset={52} />}
                <RowWithAction
                  onPress={() => edit(toDraft(r))}
                  accessibilityLabel={`${r.name}, ${ruleSummary(r, (tid) => ws.teammate(tid)?.name)}`}
                  accessibilityHint="Edits the rule"
                  action={<View style={{ paddingRight: 4 }}><Toggle value={r.enabled} onChange={(v) => setEnabled(r, v)} /></View>}
                >
                  <View style={{ width: 28, alignItems: 'center' }}><Icon icon={typeOf(r.event_type).icon} size={18} color={r.enabled ? 'ink2' : 'ink4'} /></View>
                  <RowText title={r.name} subtitle={ruleSummary(r, (tid) => ws.teammate(tid)?.name)} lines={2} dim={!r.enabled} />
                </RowWithAction>
              </View>
            ))}
          </Surface>
        )}
      </FormSection>

      <FormSection title="Webhook" hint="One address for all your projects. The first matching rule picks the event up.">
        {url ? (
          <>
            <CodeBlock label="Your webhook URL" value={url} onCopy={() => copy(url, 'Webhook URL')} />
            <CodeBlock label="Try it with curl" value={curl!} onCopy={() => copy(curl!, 'curl command')} />
          </>
        ) : (
          <Skeleton height={80} radius={12} />
        )}
      </FormSection>

      <RuleSheet
        key={session}
        open={open}
        draft={editing}
        project={p}
        members={members}
        onChange={setEditing}
        onClose={() => setOpen(false)}
        onSaved={() => { setOpen(false); load() }}
      />
    </>
  )
}

function RuleSheet({ open, draft, project, members, onChange, onClose, onSaved }: {
  open: boolean
  draft: RuleDraft | null
  project: Project
  members: Teammate[]
  onChange: (d: RuleDraft) => void
  onClose: () => void
  onSaved: () => void
}) {
  const { height } = useWindowDimensions()
  const kb = useReanimatedKeyboardAnimation()
  const [errors, setErrors] = useState<{ name?: string; custom?: string; teammate?: string }>({})
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const scroll = useAnimatedStyle(() => ({ maxHeight: Math.max(220, height * 0.72 + kb.height.value) }))
  if (!draft) return null
  const d = draft
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => onChange({ ...d, [k]: v })
  const eventType = d.type === 'custom' ? d.custom.trim().toLowerCase().replace(/\s+/g, '_') : d.type

  const save = async () => {
    const e: typeof errors = {}
    if (!d.name.trim()) e.name = 'Name the rule so you can find it later.'
    if (d.type === 'custom' && !eventType) e.custom = 'Name the event type your service sends, like deploy_failed.'
    if (!d.teammate_id) e.teammate = 'Pick who handles it.'
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy('save')
    // Schedules run in the user's own time zone, like the ones set up from chat.
    const match = Object.fromEntries(d.match.filter((m) => m.k.trim()).map((m) => [m.k.trim(), m.v]))
    const row = {
      name: d.name.trim(), event_type: eventType, match, project_id: project.id, teammate_id: d.teammate_id!,
      instructions: d.instructions.trim(), max_per_hour: d.max_per_hour, enabled: d.enabled,
    }
    const { error } = d.id
      ? await supabase.from('event_rules').update(row).eq('id', d.id)
      : await supabase.from('event_rules').insert(row)
    setBusy(null)
    if (error) { toast({ title: 'Unable to save the rule', body: 'Check your connection and try again.', tone: 'error' }); return }
    haptic.success()
    onSaved()
  }

  const test = async () => {
    if (!d.id) return
    setBusy('test')
    try {
      await api(`/event-rules/${d.id}/test`, { method: 'POST' })
      haptic.success()
      const who = members.find((m) => m.id === d.teammate_id)?.name ?? 'The teammate'
      toast({
        title: 'Test event sent',
        body: `${who} will reply in ${project.name}.`,
        action: { label: 'Open chat', onPress: () => { onClose(); router.push({ pathname: '/chat/[threadId]', params: { threadId: `proj:${project.id}` } }) } },
      })
    } catch (err) {
      toast({ title: 'Unable to send a test event', body: (err as Error).message, tone: 'error' })
    } finally { setBusy(null) }
  }

  const del = async () => {
    if (!d.id) return
    const ok = await confirm({ title: `Delete “${d.name}”?`, body: 'Events of this type will stop waking this teammate.', confirmLabel: 'Delete rule', destructive: true })
    if (!ok) return
    const { error } = await supabase.from('event_rules').delete().eq('id', d.id)
    if (error) toast({ title: 'Unable to delete the rule', tone: 'error', body: 'Check your connection and try again.' })
    else onSaved()
  }

  return (
    <Sheet open={open} onClose={onClose} title={d.id ? 'Edit rule' : 'New rule'}>
      <Animated.ScrollView style={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8, gap: 24 }}>
        <TextField label="Name" value={d.name} onChangeText={(v) => set('name', v)} placeholder="Checkout errors" error={errors.name} maxLength={60} />

        <FormSection title="When">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">
            {TYPES.map((t) => (
              <Chip key={t.value} label={t.label} icon={t.icon} selected={d.type === t.value} onPress={() => { haptic.tap(); set('type', t.value) }} />
            ))}
          </View>
          {d.type === 'custom' && (
            <TextField label="Event type" value={d.custom} onChangeText={(v) => set('custom', v)} placeholder="deploy_failed" autoCapitalize="none" autoCorrect={false} error={errors.custom} hint="The “type” your service sends in the webhook body." />
          )}
          <MatchRows rows={d.match} onChange={(m) => set('match', m)} />
        </FormSection>

        <FormSection title="Who handles it">
          {members.length ? (
            <TeammateToggles single teammates={members} selected={new Set(d.teammate_id ? [d.teammate_id] : [])} onToggle={(tid) => set('teammate_id', tid)} />
          ) : (
            <Text variant="caption" color="ink3">Add a member to this project first.</Text>
          )}
          {errors.teammate && <Text variant="footnote" color="danger">{errors.teammate}</Text>}
          <TextField
            label="Instructions"
            value={d.instructions}
            onChangeText={(v) => set('instructions', v)}
            placeholder="Reproduce the error in the sandbox, find the cause and post a short report."
            multiline
            showCount
            maxLength={2000}
          />
        </FormSection>

        <FormSection title="Limits">
          <Stepper value={d.max_per_hour} onChange={(v) => set('max_per_hour', v)} />
          <Toggle label="Rule is on" description="Off keeps the rule but ignores its events." value={d.enabled} onChange={(v) => set('enabled', v)} />
        </FormSection>

        <View style={{ gap: 8 }}>
          <Button label={d.id ? 'Save rule' : 'Create rule'} size="lg" fullWidth loading={busy === 'save'} onPress={save} />
          {d.id && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="Send test event" variant="soft" loading={busy === 'test'} onPress={test} style={{ flex: 1 }} fullWidth />
              <Button label="Delete rule" variant="ghost" icon={Delete02Icon} onPress={del} />
            </View>
          )}
        </View>
      </Animated.ScrollView>
    </Sheet>
  )
}

function MatchRows({ rows, onChange }: { rows: { k: string; v: string }[]; onChange: (r: { k: string; v: string }[]) => void }) {
  const upd = (i: number, patch: Partial<{ k: string; v: string }>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <View style={{ gap: 8 }}>
      <Text variant="caption" color="ink3">
        {rows.length ? 'Only events whose payload has all of these values.' : 'Every event of this type. Add a filter to narrow it down.'}
      </Text>
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TextField value={r.k} onChangeText={(k) => upd(i, { k })} placeholder="project" accessibilityLabel={`Filter ${i + 1} key`} autoCapitalize="none" autoCorrect={false} style={{ flex: 1 }} />
          <TextField value={r.v} onChangeText={(v) => upd(i, { v })} placeholder="checkout" accessibilityLabel={`Filter ${i + 1} value`} autoCapitalize="none" autoCorrect={false} style={{ flex: 1.3 }} />
          <IconButton icon={Cancel01Icon} size={40} iconSize={16} accessibilityLabel={`Remove filter ${i + 1}`} onPress={() => onChange(rows.filter((_, j) => j !== i))} />
        </View>
      ))}
      <Button label="Add filter" size="sm" variant="ghost" icon={Add01Icon} onPress={() => onChange([...rows, { k: '', v: '' }])} />
    </View>
  )
}

function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const step = (d: number) => { const n = Math.min(60, Math.max(1, value + d)); if (n !== value) { haptic.tap(); onChange(n) } }
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Most runs per hour"
      accessibilityValue={{ min: 1, max: 60, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
    >
      <View style={{ flex: 1 }}>
        <Text variant="bodyMedium">Most runs per hour</Text>
        <Text variant="caption" color="ink3">Extra events that hour are skipped.</Text>
      </View>
      <IconButton icon={MinusSignIcon} variant="soft" size={36} iconSize={16} accessibilityLabel="Fewer" disabled={value <= 1} onPress={() => step(-1)} />
      <View style={{ minWidth: 28, alignItems: 'center' }}><NumberPop value={value} variant="headline" /></View>
      <IconButton icon={Add01Icon} variant="soft" size={36} iconSize={16} accessibilityLabel="More" disabled={value >= 60} onPress={() => step(1)} />
    </View>
  )
}

function RowText({ title, subtitle, lines = 1, dim }: { title: string; subtitle: string; lines?: number; dim?: boolean }) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text variant="bodyMedium" numberOfLines={1} color={dim ? 'ink3' : 'ink'}>{title}</Text>
      <Text variant="caption" color="ink3" numberOfLines={lines}>{subtitle}</Text>
    </View>
  )
}
