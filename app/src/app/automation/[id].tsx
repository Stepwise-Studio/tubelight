// One automation: on/off, what it runs on, its instructions, and how each run went. Editable in place (name,
// schedule, instructions) with the Unsaved changes bar; app events are changed by asking the teammate in chat.
// /automation/new sets up a scheduled one (?thread= or ?teammate= preselect where it posts and who runs it).
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  AlertCircleIcon, BubbleChatIcon, CheckmarkCircle02Icon, Delete02Icon, FilterHorizontalIcon, Loading03Icon,
  MinusSignCircleIcon, Moon02Icon, MoreHorizontalIcon, PlayIcon, Stamp01Icon, Time04Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react-native'

import { AutomationGlyph } from '@/components/automation-rows'
import { FormSection, SwitchRow, TeammateToggles } from '@/components/form-bits'
import { SAVE_BAR_SPACE, SaveBar } from '@/components/save-bar'
import { ScheduleEditor } from '@/components/schedule-editor'
import { ScreenHeader } from '@/components/screen-header'
import { api } from '@/lib/api'
import {
  eventName, removeAutomation, runNow, setEnabled, timing, whenText, type Automation, type AutomationRun, type RunOutcome,
} from '@/lib/automations'
import { whenLabel } from '@/lib/format'
import { DEFAULT_SCHEDULE, describeSchedule, parseCron, sameSchedule, toCron, type Schedule } from '@/lib/schedule'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import {
  Button, Chip, Divider, EmptyState, Icon, IconButton, Press, Skeleton, Surface, TeammateAvatar, Text, TextField,
  haptic, showMenu, toast,
} from '@/ui'

interface Draft { name: string; instructions: string; schedule: Schedule | null }
type Errors = { name?: string; instructions?: string; who?: string }

const openChat = (threadId: string) => router.push({ pathname: '/chat/[threadId]', params: { threadId } })

function check(d: Draft): Errors {
  const e: Errors = {}
  if (!d.name.trim()) e.name = 'Name it so you can find it later, like “Morning brief”.'
  if (!d.instructions.trim()) e.instructions = 'Say what to do on each run: what to check and how to report it.'
  return e
}

export default function AutomationScreen() {
  const { id, thread, teammate } = useLocalSearchParams<{ id: string; thread?: string; teammate?: string }>()
  const { c } = useTheme()
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      {id === 'new' ? <NewAutomation thread={thread} teammate={teammate} /> : <Existing key={id} id={id} />}
    </View>
  )
}

// ------------------------------------------------------------------ an existing automation

function Existing({ id }: { id: string }) {
  const insets = useSafeAreaInsets()
  const ws = useWorkspace()
  const [a, setA] = useState<Automation | null | undefined>(undefined) // undefined: loading; null: deleted
  const [edit, setEdit] = useState<Draft | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => api<Automation>(`/automations/${id}`).then(setA, (e: Error) => {
    if (/not found/i.test(e.message)) setA(null)
    else { setA((x) => x ?? null); toast({ title: 'Unable to load the automation', body: e.message, tone: 'error' }) }
  }), [id])
  useFocusEffect(useCallback(() => { load() }, [load]))
  // A run in progress: check back until it lands.
  const busy = a?.runs?.some((r) => r.outcome === 'working')
  useEffect(() => {
    if (!busy) return
    const t = setTimeout(load, 4000)
    return () => clearTimeout(t)
  }, [busy, a, load])

  if (a === undefined) {
    return (
      <>
        <ScreenHeader title="Automation" />
        <View style={{ padding: 20, gap: 16 }}>
          <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
            <Skeleton width={52} height={52} radius={16} />
            <View style={{ gap: 8, flex: 1 }}><Skeleton width="60%" /><Skeleton width="40%" /></View>
          </View>
          <Skeleton height={56} radius={16} />
        </View>
      </>
    )
  }
  if (a === null) {
    return (
      <>
        <ScreenHeader title="Automation" />
        <EmptyState title="This automation was deleted" body="It no longer runs. Its past messages are still in the chat."
          action={<Button label="See all automations" variant="soft" onPress={() => router.replace('/automations')} />} />
      </>
    )
  }

  const who = ws.teammate(a.teammate_id)
  const where = a.thread_id.startsWith('dm:') ? 'Direct chat' : ws.threadTitle(a.thread_id)
  const base: Draft = { name: a.name, instructions: a.instructions, schedule: a.cron ? parseCron(a.cron) : null }
  const draft = edit ?? base
  const scheduleChanged = !!(draft.schedule && base.schedule && !sameSchedule(draft.schedule, base.schedule))
  const dirty = !!edit && (draft.name !== base.name || draft.instructions !== base.instructions || scheduleChanged)
  const set = (patch: Partial<Draft>) => setEdit({ ...draft, ...patch })

  const toggle = async (on: boolean) => {
    setA({ ...a, enabled: on })
    const res = await setEnabled(a, on)
    setA((x) => (x ? { ...x, ...(res ?? { enabled: !on }) } : x))
  }
  const save = async () => {
    const e = check(draft)
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    try {
      const res = await api<Automation>(`/automations/${a.id}`, {
        method: 'PATCH',
        json: {
          ...(draft.name !== base.name && { name: draft.name.trim() }),
          ...(draft.instructions !== base.instructions && { instructions: draft.instructions.trim() }),
          ...(scheduleChanged && draft.schedule && { cron: toCron(draft.schedule), when: describeSchedule(draft.schedule) }),
        },
      })
      setA((x) => (x ? { ...x, ...res, last_run: x.last_run } : x))
      setEdit(null)
      haptic.success()
      toast({ title: 'Changes saved', tone: 'success' })
    } catch (err) {
      toast({ title: 'Unable to save changes', body: (err as Error).message, tone: 'error' })
    } finally { setSaving(false) }
  }
  const run = async () => { if (await runNow(a)) setTimeout(load, 1500) }
  const remove = async () => { if (await removeAutomation(a)) router.back() }

  return (
    <>
      <ScreenHeader
        title="Automation"
        right={
          <IconButton
            icon={MoreHorizontalIcon}
            accessibilityLabel="More"
            onPress={() => showMenu({
              title: a.name,
              items: [
                ...(a.kind === 'schedule' ? [{ label: 'Run now', icon: PlayIcon, onPress: run }] : []),
                { label: 'Open the chat', icon: BubbleChatIcon, onPress: () => openChat(a.thread_id) },
                { label: 'Delete automation', icon: Delete02Icon, destructive: true, onPress: remove },
              ],
            })}
          />
        }
      />
      <KeyboardAwareScrollView bottomOffset={dirty ? SAVE_BAR_SPACE : 96} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: insets.bottom + (dirty ? SAVE_BAR_SPACE : 40), gap: 28 }}>
        <View style={{ gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <AutomationGlyph a={a} size={52} />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text variant="headline" numberOfLines={2}>{a.name}</Text>
              <Press radius={8} static onPress={() => openChat(a.thread_id)} accessibilityLabel={`Runs as ${who?.name ?? 'a teammate'} in ${where}. Opens the chat.`}
                outerStyle={{ alignSelf: 'flex-start' }} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {who && <TeammateAvatar teammate={who} size={18} interactive={false} />}
                <Text variant="caption" color="ink3" numberOfLines={1}>{who?.name ?? 'A teammate'} · {where}</Text>
              </Press>
            </View>
          </View>
          <Surface style={{ overflow: 'hidden' }}>
            <SwitchRow title={a.enabled ? 'On' : 'Paused'} subtitle={a.enabled ? timing(a) : 'It won’t run until you turn it back on.'}
              value={a.enabled} onChange={toggle} />
          </Surface>
        </View>

        <FormSection title="Name">
          <TextField value={draft.name} onChangeText={(v) => set({ name: v })} maxLength={80} error={errors.name} />
        </FormSection>

        <FormSection title="When" hint={a.kind === 'schedule' ? 'In your time zone.' : `To change the event or its filters, ask ${who?.name ?? 'the teammate'} in the chat.`}>
          {a.kind === 'schedule' && draft.schedule ? (
            <ScheduleEditor value={draft.schedule} onChange={(s) => set({ schedule: s })} />
          ) : (
            <AppEvent a={a} />
          )}
        </FormSection>

        <FormSection title="Instructions" hint={`What ${who?.name ?? 'the teammate'} does on each run. With nothing new to say, it stays quiet.`}>
          <TextField value={draft.instructions} onChangeText={(v) => set({ instructions: v })} multiline showCount maxLength={2000} error={errors.instructions} />
        </FormSection>

        <FormSection
          title="Runs"
          hint={a.runs?.length ? 'The last 20, newest first.' : undefined}
          action={a.kind === 'schedule' ? <Button label="Run now" size="sm" variant="soft" icon={PlayIcon} onPress={run} /> : undefined}
        >
          {!a.runs?.length ? (
            <Text variant="caption" color="ink3">
              {a.kind === 'schedule' ? `It hasn’t run yet.${a.next_run && a.enabled ? ` First run ${whenLabel(a.next_run)}.` : ''}` : 'It runs when its event happens. Nothing yet.'}
            </Text>
          ) : (
            <Surface style={{ overflow: 'hidden' }}>
              {a.runs.map((r, i) => (
                <View key={`${r.at}-${i}`}>
                  {i > 0 && <Divider inset={44} />}
                  <RunRow r={r} onOpen={() => openChat(a.thread_id)} />
                </View>
              ))}
            </Surface>
          )}
        </FormSection>

        <Button label="Delete automation" variant="outline" icon={Delete02Icon} onPress={remove} />
      </KeyboardAwareScrollView>

      {dirty && (
        <SaveBar body="Save to update this automation, or discard to keep it as it was." saving={saving}
          onDiscard={() => { setEdit(null); setErrors({}) }} onSave={save} />
      )}
    </>
  )
}

function AppEvent({ a }: { a: Automation }) {
  const rows: [string, string][] = [
    ['Event', a.trigger ? eventName(a.trigger) : 'An app event'],
    ...Object.entries(a.settings).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k.replace(/_/g, ' '), String(v)] as [string, string]),
    ...(a.keywords.length ? [['Only if it mentions', a.keywords.join(', ')] as [string, string]] : []),
  ]
  return (
    <Surface padding={14} style={{ gap: 10 }}>
      {a.when ? <Text variant="bodyMedium">{whenText(a)}</Text> : null}
      {rows.map(([k, v]) => (
        <View key={k} style={{ gap: 2 }}>
          <Text variant="footnote" color="ink3">{k}</Text>
          <Text variant="caption" color="ink2" selectable>{v}</Text>
        </View>
      ))}
    </Surface>
  )
}

const OUTCOME: Record<RunOutcome, { label: string; icon: IconSvgElement; color: string }> = {
  posted: { label: 'Posted in the chat', icon: CheckmarkCircle02Icon, color: 'success' },
  quiet: { label: 'Nothing new, stayed quiet', icon: Moon02Icon, color: 'ink3' },
  approval: { label: 'Waiting for your approval', icon: Stamp01Icon, color: 'warning' },
  working: { label: 'Running now', icon: Loading03Icon, color: 'tube' },
  failed: { label: 'Couldn’t finish', icon: AlertCircleIcon, color: 'danger' },
  cancelled: { label: 'Stopped', icon: MinusSignCircleIcon, color: 'ink3' },
  filtered: { label: 'Skipped: didn’t mention the keywords', icon: FilterHorizontalIcon, color: 'ink3' },
  limited: { label: 'Skipped: over its hourly limit', icon: Time04Icon, color: 'ink3' },
}

function RunRow({ r, onOpen }: { r: AutomationRun; onOpen: () => void }) {
  const o = OUTCOME[r.outcome]
  const preview = r.preview.replace(/[*_#`>|]/g, '').replace(/\s+/g, ' ').trim()
  const body = (
    <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 12 }}>
      <View style={{ paddingTop: 1 }}><Icon icon={o.icon} size={18} color={o.color} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>{o.label}</Text>
          <Text variant="footnote" color="ink3">{whenLabel(r.at)}</Text>
        </View>
        {!!preview && <Text variant="caption" color="ink3" numberOfLines={2}>{preview}</Text>}
      </View>
    </View>
  )
  const opens = r.outcome === 'posted' || r.outcome === 'approval'
  return opens
    ? <Press radius={0} static onPress={onOpen} accessibilityLabel={`${o.label}, ${whenLabel(r.at)}. ${preview}`} accessibilityHint="Opens the chat">{body}</Press>
    : <View accessible accessibilityLabel={`${o.label}, ${whenLabel(r.at)}`}>{body}</View>
}

// ------------------------------------------------------------------ a new one

function NewAutomation({ thread, teammate }: { thread?: string; teammate?: string }) {
  const insets = useSafeAreaInsets()
  const ws = useWorkspace()
  const first = teammate
    ?? (thread?.startsWith('dm:') ? thread.slice(3) : thread?.startsWith('proj:') ? ws.membersOf(thread.slice(5))[0]?.id : undefined)
    ?? ws.teammates[0]?.id
  const [who, setWho] = useState<string | null>(first ?? null)
  const [project, setProject] = useState<string | null>(thread?.startsWith('proj:') ? thread.slice(5) : null)
  const [d, setD] = useState<Draft>({ name: '', instructions: '', schedule: DEFAULT_SCHEDULE })
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  const tm = ws.teammate(who)
  const projects = ws.projects.filter((p) => ws.members.some((m) => m.project_id === p.id && m.teammate_id === who))
  const pick = (tid: string) => {
    setWho(tid)
    if (project && !ws.members.some((m) => m.project_id === project && m.teammate_id === tid)) setProject(null)
  }

  const create = async () => {
    const e = check(d)
    if (!who) e.who = 'Pick who runs it.'
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      const s = d.schedule ?? DEFAULT_SCHEDULE
      const res = await api<Automation>('/automations', {
        method: 'POST',
        json: {
          teammate_id: who, project_id: project, name: d.name.trim(), instructions: d.instructions.trim(),
          cron: toCron(s), when: describeSchedule(s), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      })
      haptic.success()
      toast({ title: 'Automation set up', tone: 'success' })
      router.replace({ pathname: '/automation/[id]', params: { id: res.id } })
    } catch (err) {
      toast({ title: 'Unable to set it up', body: (err as Error).message, tone: 'error' })
    } finally { setBusy(false) }
  }

  return (
    <>
      <ScreenHeader title="New automation" />
      <KeyboardAwareScrollView bottomOffset={96} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 40, gap: 28 }}>
        <Text variant="caption" color="ink3">
          A teammate runs it on its own and posts in the chat you pick. To react to something in an app instead (a new mail, a new issue), ask a teammate in chat and they’ll find the right event.
        </Text>

        <FormSection title="Who runs it">
          {ws.teammates.length ? (
            <TeammateToggles single teammates={ws.teammates} selected={new Set(who ? [who] : [])} onToggle={pick} />
          ) : (
            <Text variant="caption" color="ink3">Add a teammate first.</Text>
          )}
          {errors.who && <Text variant="footnote" color="danger">{errors.who}</Text>}
        </FormSection>

        {tm && (
          <FormSection title="Where it posts">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">
              <Chip label={`Direct chat with ${tm.name}`} selected={!project} onPress={() => { haptic.tap(); setProject(null) }} />
              {projects.map((p) => <Chip key={p.id} label={p.name} selected={project === p.id} onPress={() => { haptic.tap(); setProject(p.id) }} />)}
            </View>
          </FormSection>
        )}

        <FormSection title="When">
          <ScheduleEditor value={d.schedule ?? DEFAULT_SCHEDULE} onChange={(s) => setD({ ...d, schedule: s })} />
        </FormSection>

        <FormSection title="Name">
          <TextField value={d.name} onChangeText={(v) => setD({ ...d, name: v })} placeholder="Morning brief" maxLength={80} error={errors.name} />
        </FormSection>

        <FormSection title="Instructions" hint="What to do on each run. With nothing new to say, it stays quiet.">
          <TextField value={d.instructions} onChangeText={(v) => setD({ ...d, instructions: v })} multiline showCount maxLength={2000}
            placeholder="Go through my new mail since the last run and tell me what needs me, most urgent first." error={errors.instructions} />
        </FormSection>

        <Button label="Set up automation" size="lg" fullWidth loading={busy} onPress={create} />
      </KeyboardAwareScrollView>
    </>
  )
}
