// One automation: on/off, anything stopping it, the form (edit in place, Unsaved changes bar), how its runs went.
// /automation/new sets one up: describe it in plain words and the form fills itself, or fill it in by hand
// (?thread= or ?teammate= preselect where it posts and who runs it).
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

import {
  AutomationForm, DescribeStep, Understood, checkDraft, createBody, draftOf, emptyDraft, patchBody, useAppEvents,
  type AutomationDraft, type AutomationErrors,
} from '@/components/automation-form'
import { AutomationGlyph } from '@/components/automation-rows'
import { FormSection, SwitchRow } from '@/components/form-bits'
import { SAVE_BAR_SPACE, SaveBar } from '@/components/save-bar'
import { ScreenHeader } from '@/components/screen-header'
import { api } from '@/lib/api'
import {
  removeAutomation, runNow, setEnabled, timing, type Automation, type AutomationRun, type RunOutcome,
} from '@/lib/automations'
import { whenLabel } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import {
  Button, Checkbox, Divider, EmptyState, Icon, IconButton, Notice, Press, Skeleton, Surface, TeammateAvatar, Text,
  haptic, showMenu, toast,
} from '@/ui'

const openChat = (threadId: string) => router.push({ pathname: '/chat/[threadId]', params: { threadId } })
const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const city = (tz: string) => tz.split('/').pop()!.replace(/_/g, ' ')

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
  const [edit, setEdit] = useState<AutomationDraft | null>(null)
  const [errors, setErrors] = useState<AutomationErrors>({})
  const [saving, setSaving] = useState(false)
  const base = a ? draftOf(a) : null
  const draft = edit ?? base
  const { events, error: eventsError } = useAppEvents(draft?.kind === 'app' ? draft.app : null)

  const load = useCallback(() => api<Automation>(`/automations/${id}`).then(setA, (e: Error) => {
    if (/not found/i.test(e.message)) setA(null)
    else { setA((x) => x ?? null); toast({ title: 'Unable to load the automation', body: e.message, tone: 'error' }) }
  }), [id])
  useFocusEffect(useCallback(() => { load() }, [load]))
  const busy = a?.runs?.some((r) => r.outcome === 'working') // a run in progress: check back until it lands
  useEffect(() => {
    if (!busy) return
    const t = setTimeout(load, 4000)
    return () => clearTimeout(t)
  }, [busy, a, load])

  if (!a || !base || !draft) {
    return a === null ? (
      <>
        <ScreenHeader title="Automation" />
        <EmptyState title="This automation was deleted" body="It no longer runs. Its past messages are still in the chat."
          action={<Button label="See all automations" variant="soft" onPress={() => router.replace('/automations')} />} />
      </>
    ) : (
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

  const who = ws.teammate(a.teammate_id)
  const where = a.thread_id.startsWith('dm:') ? 'Direct chat' : ws.threadTitle(a.thread_id)
  const changes = edit ? patchBody(base, edit, events) : {}
  const dirty = Object.keys(changes).length > 0

  const toggle = async (on: boolean) => {
    setA({ ...a, enabled: on })
    const res = await setEnabled(a, on)
    setA((x) => (x ? { ...x, ...(res ?? { enabled: !on }) } : x))
    if (res) load()
  }
  const patch = async (body: Record<string, unknown>, done: string) => {
    const res = await api<Automation>(`/automations/${a.id}`, { method: 'PATCH', json: body })
    setA((x) => (x ? { ...x, ...res, last_run: x.last_run, runs: x.runs } : x))
    haptic.success()
    toast({ title: done, tone: 'success' })
  }
  const save = async () => {
    const e = checkDraft(draft, events)
    setErrors(e)
    if (Object.keys(e).length) { haptic.error(); return }
    setSaving(true)
    try {
      await patch(changes, 'Changes saved')
      setEdit(null)
    } catch (err) {
      toast({ title: 'Unable to save changes', body: (err as Error).message, tone: 'error' })
    } finally { setSaving(false) }
  }
  const run = async () => { if (await runNow(a)) setTimeout(load, 1500) }
  const remove = async () => { if (await removeAutomation(a)) router.back() }

  // The automation keeps the time zone it was set up in; after travel "8 AM" still means that zone's 8 AM.
  const tz = deviceTz()
  const tzNote = a.kind === 'schedule' && a.tz && a.tz !== tz ? (
    <View style={{ gap: 8 }}>
      <Text variant="footnote" color="ink2">It runs on {city(a.tz)} time. This phone is on {city(tz)} time now.</Text>
      <Button label={`Use ${city(tz)} time`} size="sm" variant="soft" style={{ alignSelf: 'flex-start' }}
        onPress={() => patch({ tz }, `Now on ${city(tz)} time`).then(load, (e: Error) => toast({ title: 'Unable to change it', body: e.message, tone: 'error' }))} />
    </View>
  ) : undefined

  return (
    <>
      <ScreenHeader
        title="Automation"
        right={
          <IconButton icon={MoreHorizontalIcon} accessibilityLabel="More" onPress={() => showMenu({
            title: a.name,
            items: [
              ...(a.kind === 'schedule' ? [{ label: 'Run now', icon: PlayIcon, onPress: run }] : []),
              { label: 'Open the chat', icon: BubbleChatIcon, onPress: () => openChat(a.thread_id) },
              { label: 'Delete automation', icon: Delete02Icon, destructive: true, onPress: remove },
            ],
          })} />
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
            <SwitchRow title={a.enabled ? 'On' : 'Paused'} subtitle={a.enabled ? timing(a) : 'It won’t run until you turn it back on.'} value={a.enabled} onChange={toggle} />
          </Surface>
          {a.problems.map((p) => <Notice key={p} tone="warning" title="Needs attention" body={p} />)}
        </View>

        <AutomationForm draft={draft} onChange={setEdit} errors={errors} events={events} eventsError={eventsError}
          isNew={false} upcoming={a.upcoming} tzNote={tzNote} />

        <FormSection
          title="Runs"
          hint={a.runs?.length ? 'The last 20, newest first.' : undefined}
          action={a.kind === 'schedule' ? <Button label="Run now" size="sm" variant="soft" icon={PlayIcon} onPress={run} /> : undefined}
        >
          {!a.runs?.length ? (
            <Text variant="caption" color="ink3">
              {a.kind === 'schedule' ? `It hasn’t run yet.${a.next_run ? ` First run ${whenLabel(a.next_run)}.` : ''}` : 'It runs when its event happens. Nothing yet.'}
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

        <Button label="Delete automation" variant="outline" icon={Delete02Icon} fullWidth onPress={remove} />
      </KeyboardAwareScrollView>

      {dirty && (
        <SaveBar body="Save to update this automation, or discard to keep it as it was." saving={saving}
          onDiscard={() => { setEdit(null); setErrors({}) }} onSave={save} />
      )}
    </>
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
  const when = `${whenLabel(r.at)}${r.late ? ' · late' : ''}`
  const body = (
    <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 12 }}>
      <View style={{ paddingTop: 1 }}><Icon icon={o.icon} size={18} color={o.color} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>{o.label}</Text>
          <Text variant="footnote" color="ink3">{when}</Text>
        </View>
        {!!preview && <Text variant="caption" color={r.outcome === 'failed' ? 'danger' : 'ink3'} numberOfLines={2}>{preview}</Text>}
      </View>
    </View>
  )
  const opens = r.outcome === 'posted' || r.outcome === 'approval'
  return opens
    ? <Press radius={0} static onPress={onOpen} accessibilityLabel={`${o.label}, ${when}. ${preview}`} accessibilityHint="Opens the chat">{body}</Press>
    : <View accessible accessibilityLabel={`${o.label}, ${when}. ${preview}`}>{body}</View>
}

// ------------------------------------------------------------------ a new one

function NewAutomation({ thread, teammate }: { thread?: string; teammate?: string }) {
  const insets = useSafeAreaInsets()
  const ws = useWorkspace()
  const project = thread?.startsWith('proj:') ? thread.slice(5) : null
  const first = teammate ?? (thread?.startsWith('dm:') ? thread.split(':')[1] : project ? ws.membersOf(project)[0]?.id : undefined) ?? ws.teammates[0]?.id
  const [d, setD] = useState<AutomationDraft>(() => emptyDraft(first ?? null, project))
  const [errors, setErrors] = useState<AutomationErrors>({})
  const [note, setNote] = useState('')
  const [tryNow, setTryNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<'describe' | 'form'>('describe')
  const [filled, setFilled] = useState(false)
  const { events, error: eventsError } = useAppEvents(d.kind === 'app' ? d.app : null)

  const create = async () => {
    const e = checkDraft(d, events)
    setErrors(e)
    if (Object.keys(e).length) { haptic.error(); toast({ title: 'A few things to fill in', body: Object.values(e)[0], tone: 'warning' }); return }
    setBusy(true)
    try {
      const res = await api<Automation>('/automations', { method: 'POST', json: createBody(d, events, tryNow && d.kind === 'schedule') })
      haptic.success()
      toast({ title: 'Automation set up', body: tryNow && d.kind === 'schedule' ? 'Its first run is on the way to the chat.' : undefined, tone: 'success' })
      router.replace({ pathname: '/automation/[id]', params: { id: res.id } })
    } catch (err) {
      toast({ title: 'Unable to set it up', body: (err as Error).message, tone: 'error' })
    } finally { setBusy(false) }
  }

  return (
    <>
      <ScreenHeader title="New automation" />
      <KeyboardAwareScrollView key={step} bottomOffset={96} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 40, gap: 28 }}>
        {step === 'describe' ? (
          <DescribeStep draft={d} onTeammate={(id) => setD({ ...emptyDraft(id, project), name: d.name, instructions: d.instructions })}
            onFilled={(next, n) => { setD(next); setErrors({}); setNote(n); setFilled(true); setStep('form') }}
            onManual={() => setStep('form')} />
        ) : (
          <>
            {filled && <Understood draft={d} events={events} />}
            {!!note && <Notice tone="info" title="Check this part" body={note} onDismiss={() => setNote('')} />}
        <AutomationForm draft={d} onChange={setD} errors={errors} events={events} eventsError={eventsError} isNew />
        <View style={{ gap: 14 }}>
          {d.kind === 'schedule' && <Checkbox value={tryNow} onChange={setTryNow} label="Run it once now, so I can see what it does" />}
          <Button label="Set up automation" size="lg" fullWidth loading={busy} onPress={create} />
          <Button label="Start over" variant="ghost" fullWidth onPress={() => { setStep('describe'); setFilled(false); setNote('') }} />
        </View>
          </>
        )}
      </KeyboardAwareScrollView>
    </>
  )
}
