// The automation form, shared by /automation/new and each automation's page. Top to bottom it asks what people
// think about first: what to call it and what to do, who does it and with which apps, when, and where it posts.
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, TextInput, View } from 'react-native'
import { AlertCircleIcon } from '@hugeicons/core-free-icons'

import { BrandTile } from '@/components/brand-mark'
import { FormSection, SwitchRow } from '@/components/form-bits'
import { ThreadAvatar } from '@/components/thread-avatar'
import { api } from '@/lib/api'
import type { AppEvent, Automation } from '@/lib/automations'
import { toolkitName, useConnections } from '@/lib/catalog'
import { whenLabel } from '@/lib/format'
import {
  DAY_SHORT, DEFAULT_SCHEDULE, EVERY_HOURS, capitalize, describeSchedule, nextRuns, parseCron, repeatOf, sameSchedule,
  toCron, withRepeat, type Repeat, type Schedule,
} from '@/lib/schedule'
import { useWorkspace } from '@/lib/workspace'
import { fonts, useTheme } from '@/theme'
import {
  Button, Chip, Collapse, Divider, Icon, Press, PickerField, Segment, Surface, TeammateAvatar, Text, TextField, TimePicker,
  haptic, toast, type PickerOption,
} from '@/ui'

export interface AutomationDraft {
  name: string
  instructions: string
  teammateId: string | null
  /** Where it posts: a project, or null for the teammate's direct chat. */
  projectId: string | null
  kind: 'schedule' | 'app'
  schedule: Schedule
  app: string | null
  trigger: string | null
  settings: Record<string, string>
  /** Comma-separated in the form; every word must appear in the event. */
  keywords: string
  /** The apps its runs may use; null = all of the teammate's. */
  toolkits: string[] | null
}
export type AutomationErrors = Partial<Record<'name' | 'instructions' | 'who' | 'when', string>>

export const emptyDraft = (teammateId: string | null, projectId: string | null): AutomationDraft => ({
  name: '', instructions: '', teammateId, projectId, kind: 'schedule', schedule: DEFAULT_SCHEDULE, app: null, trigger: null,
  settings: {}, keywords: '', toolkits: null,
})

export const draftOf = (a: Automation): AutomationDraft => ({
  name: a.name, instructions: a.instructions, teammateId: a.teammate_id,
  projectId: a.thread_id.startsWith('proj:') ? a.thread_id.slice(5) : null, kind: a.kind,
  schedule: a.cron ? parseCron(a.cron) : DEFAULT_SCHEDULE, app: a.app, trigger: a.trigger,
  settings: Object.fromEntries(Object.entries(a.settings).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
  keywords: a.keywords.join(', '), toolkits: a.toolkits,
})

const words = (s: string) => s.split(',').map((w) => w.trim()).filter(Boolean)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Plain-words timing for the capsule and lists. */
export function whenOf(d: AutomationDraft, events: AppEvent[] | null): string {
  if (d.kind === 'schedule') return describeSchedule(d.schedule)
  const ev = events?.find((e) => e.slug === d.trigger)
  const kw = words(d.keywords)
  return `when ${ev ? eventTitle(ev.name).toLowerCase() : 'its event'} happens in ${toolkitName(d.app ?? '')}${kw.length ? ` mentioning ${kw.join(', ')}` : ''}`
}

/** Settings as the app expects them: numbers and true/false where its schema says so. */
function typedSettings(d: AutomationDraft, ev: AppEvent | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, raw] of Object.entries(d.settings)) {
    const v = raw.trim()
    if (!v) continue
    const t = ev?.types[k]
    out[k] = t === 'integer' || t === 'number' ? Number(v) : t === 'boolean' ? v === 'true' : v
  }
  return out
}

export function checkDraft(d: AutomationDraft, events: AppEvent[] | null): AutomationErrors {
  const e: AutomationErrors = {}
  if (!d.name.trim()) e.name = 'Name it so you can find it later, like “Morning brief”.'
  if (!d.instructions.trim()) e.instructions = 'Say what to do on each run: what to check, what counts, how to report it.'
  if (!d.teammateId) e.who = 'Pick who runs it.'
  if (d.kind === 'app') {
    const ev = events?.find((x) => x.slug === d.trigger)
    if (!d.app) e.when = 'Pick the app whose event starts it.'
    else if (!ev) e.when = 'Pick which event starts it.'
    else {
      const missing = ev.required.filter((k) => !d.settings[k]?.trim())
      if (missing.length) e.when = `Fill in ${missing.map(label).join(', ')}.`
      else if (ev.required.some((k) => (ev.types[k] === 'integer' || ev.types[k] === 'number') && Number.isNaN(Number(d.settings[k])))) e.when = 'Some settings need a number.'
    }
  }
  return e
}

/** The body for POST /automations. */
export function createBody(d: AutomationDraft, events: AppEvent[] | null, runNow: boolean) {
  const ev = events?.find((x) => x.slug === d.trigger)
  return {
    teammate_id: d.teammateId, project_id: d.projectId, name: d.name.trim(), instructions: d.instructions.trim(),
    when: whenOf(d, events), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, toolkits: d.toolkits, run_now: runNow,
    ...(d.kind === 'schedule' ? { cron: toCron(d.schedule) } : { trigger: d.trigger, settings: typedSettings(d, ev), keywords: words(d.keywords) }),
  }
}

/** Only what changed, for PATCH /automations/:id. Empty when nothing did. */
export function patchBody(base: AutomationDraft, d: AutomationDraft, events: AppEvent[] | null): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (d.name !== base.name) p.name = d.name.trim()
  if (d.instructions !== base.instructions) p.instructions = d.instructions.trim()
  if (d.teammateId !== base.teammateId) p.teammate_id = d.teammateId
  if (d.projectId !== base.projectId || d.teammateId !== base.teammateId) p.project_id = d.projectId
  if (!same(d.toolkits, base.toolkits)) p.toolkits = d.toolkits
  if (d.kind === 'schedule' && !sameSchedule(d.schedule, base.schedule)) { p.cron = toCron(d.schedule); p.when = whenOf(d, events) }
  if (d.kind === 'app') {
    const ev = events?.find((x) => x.slug === d.trigger)
    if (d.trigger !== base.trigger || !same(d.settings, base.settings)) { p.trigger = d.trigger; p.settings = typedSettings(d, ev) }
    if (d.keywords !== base.keywords) p.keywords = words(d.keywords)
    if (Object.keys(p).some((k) => ['trigger', 'settings', 'keywords'].includes(k))) p.when = whenOf(d, events)
  }
  return p
}

const eventTitle = (name: string) => name.replace(/\s*trigger$/i, '')
const label = (k: string) => capitalize(k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())

/** An app's events, loaded when the app is picked (and kept per app). */
const eventCache: Record<string, AppEvent[]> = {}
export function useAppEvents(app: string | null) {
  const [got, setGot] = useState<{ app: string; events?: AppEvent[]; error?: string } | null>(null)
  useEffect(() => {
    if (!app || eventCache[app]) return
    let live = true
    api<AppEvent[]>(`/apps/${app}/events`).then(
      (l) => { eventCache[app] = l; if (live) setGot({ app, events: l }) },
      (e: Error) => { if (live) setGot({ app, error: e.message }) },
    )
    return () => { live = false }
  }, [app])
  const mine = got?.app === app ? got : null
  return { events: app ? eventCache[app] ?? mine?.events ?? null : null, error: mine?.error ?? null }
}

export function AutomationForm({ draft, onChange, errors, events, eventsError, isNew, upcoming, tzNote, hideWho }: {
  draft: AutomationDraft
  onChange: (d: AutomationDraft) => void
  errors: AutomationErrors
  events: AppEvent[] | null
  eventsError: string | null
  isNew: boolean
  /** The service's next runs, shown while the schedule is unchanged. */
  upcoming?: string[]
  /** Shown under When: the automation keeps another time zone than this phone's. */
  tzNote?: React.ReactNode
  /** The new-automation screen picks who above the form. */
  hideWho?: boolean
}) {
  const ws = useWorkspace()
  const { connections } = useConnections()
  const set = (patch: Partial<AutomationDraft>) => onChange({ ...draft, ...patch })
  const tm = ws.teammate(draft.teammateId)
  const connected = new Set((connections ?? []).filter((x) => x.connected).map((x) => x.toolkit))
  const apps = tm?.allowed_toolkits ?? []

  const pickTeammate = (id: string) => {
    const next = ws.teammate(id)
    const allowed = new Set(next?.allowed_toolkits ?? [])
    const inProject = draft.projectId && ws.members.some((m) => m.project_id === draft.projectId && m.teammate_id === id)
    onChange({
      ...draft, teammateId: id, projectId: inProject ? draft.projectId : null,
      toolkits: draft.toolkits?.filter((t) => allowed.has(t)) ?? null,
      ...(draft.app && !allowed.has(draft.app) ? { app: null, trigger: null, settings: {} } : {}),
    })
  }

  const whoOptions: PickerOption[] = ws.teammates.map((t) => ({
    value: t.id, title: t.name, subtitle: t.role, keywords: t.handle,
    leading: <TeammateAvatar teammate={t} size={36} interactive={false} />,
  }))
  const projects = ws.projects.filter((p) => ws.members.some((m) => m.project_id === p.id && m.teammate_id === draft.teammateId))
  const whereOptions: PickerOption[] = tm ? [
    { value: '', title: `Direct chat with ${tm.name}`, subtitle: 'Just the two of you', leading: <ThreadAvatar threadId={`dm:${tm.id}`} size={36} /> },
    ...projects.map((p) => ({
      value: p.id, title: p.name, subtitle: `${ws.membersOf(p.id).length} members`, group: 'Projects',
      leading: <ThreadAvatar threadId={`proj:${p.id}`} size={36} />,
    })),
  ] : []

  return (
    <View style={{ gap: 28 }}>
      <FormSection title="Name">
        <TextField value={draft.name} onChangeText={(v) => set({ name: v })} placeholder="Morning brief" maxLength={80} error={errors.name} />
      </FormSection>

      <FormSection title="Instructions" hint={`What ${tm?.name ?? 'the teammate'} does on each run. With nothing new to say, it stays quiet.`}>
        <TextField value={draft.instructions} onChangeText={(v) => set({ instructions: v })} multiline showCount maxLength={2000}
          placeholder="Go through my new mail since the last run and tell me what needs me, most urgent first." error={errors.instructions} />
      </FormSection>

      {!hideWho && (
        <FormSection title="Runs as">
          <PickerField label="Runs as" value={draft.teammateId} options={whoOptions} onChange={pickTeammate} placeholder="Pick a teammate" />
          {errors.who && <Text variant="footnote" color="danger">{errors.who}</Text>}
        </FormSection>
      )}

      {tm && (
        <FormSection title="Apps it can use" hint={apps.length ? 'Only what’s on here. Anything that sends, posts or changes things still asks you first.' : undefined}>
          {apps.length === 0 ? (
            <Text variant="caption" color="ink3">{tm.name} has no apps yet. Add some in {tm.name}’s settings, or pick another teammate.</Text>
          ) : (
            <Surface style={{ overflow: 'hidden' }}>
              {apps.map((t, i) => {
                const on = draft.toolkits === null || draft.toolkits.includes(t)
                const needed = draft.kind === 'app' && draft.app === t
                return (
                  <View key={t}>
                    {i > 0 && <Divider inset={60} />}
                    <SwitchRow
                      title={toolkitName(t)}
                      subtitle={needed ? 'Its events start this automation' : connected.has(t) || !connections ? undefined : 'Not connected: runs can’t use it'}
                      leading={<BrandTile toolkit={t} size={32} />}
                      value={on || needed}
                      onChange={(v) => {
                        if (needed) { toast({ title: `${toolkitName(t)} starts this automation`, body: 'Pick another event first to turn it off.' }); return }
                        const now = draft.toolkits ?? apps
                        const next = v ? [...now, t] : now.filter((x) => x !== t)
                        set({ toolkits: apps.every((a) => next.includes(a)) ? null : next })
                      }}
                    />
                  </View>
                )
              })}
            </Surface>
          )}
        </FormSection>
      )}

      <FormSection title="When">
        <Segment<'schedule' | 'app'>
          value={draft.kind}
          onChange={(k) => { if (isNew) set({ kind: k }) }}
          accessibilityLabel="Starts"
          options={[{ value: 'schedule', label: 'On a schedule' }, { value: 'app', label: 'On an app event' }]}
        />
        {!isNew && <Text variant="footnote" color="ink3">To switch between a schedule and an app event, set up a new automation.</Text>}
        {draft.kind === 'schedule'
          ? <ScheduleFields schedule={draft.schedule} onChange={(s) => set({ schedule: s })} upcoming={upcoming} />
          : <AppEventFields draft={draft} onChange={onChange} apps={apps} connected={connected} events={events} eventsError={eventsError} />}
        {tzNote}
        {errors.when && <Text variant="footnote" color="danger">{errors.when}</Text>}
      </FormSection>

      {tm && (
        <FormSection title="Posts in">
          <PickerField label="Posts in" value={draft.projectId ?? ''} options={whereOptions} onChange={(v) => set({ projectId: v || null })}
            intro={`Where ${tm.name} posts each run. Only chats ${tm.name} is in.`} />
        </FormSection>
      )}
    </View>
  )
}

const REPEATS: { value: Repeat; label: string }[] = [
  { value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'weekends', label: 'Weekends' },
  { value: 'days', label: 'Pick days' }, { value: 'hours', label: 'Every few hours' },
]

function ScheduleFields({ schedule, onChange, upcoming }: { schedule: Schedule; onChange: (s: Schedule) => void; upcoming?: string[] }) {
  const { c } = useTheme()
  const [base] = useState(schedule)
  const repeat = repeatOf(schedule)
  const preview = useMemo(() => (upcoming && sameSchedule(schedule, base) ? upcoming.map((d) => new Date(d)) : nextRuns(schedule)), [schedule, base, upcoming])
  const week = [1, 2, 3, 4, 5, 6, 0]
  return (
    <View style={{ gap: 14 }}>
      {schedule.kind === 'custom' && (
        <Text variant="caption" color="ink3">Set up in chat on a custom schedule ({schedule.cron}). Pick one below to replace it, or leave it.</Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">
        {REPEATS.map((r) => (
          <Chip key={r.value} label={r.label} selected={repeat === r.value} onPress={() => { haptic.tap(); onChange(withRepeat(schedule, r.value)) }} />
        ))}
      </View>
      {schedule.kind === 'time' && repeat === 'days' && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {week.map((d) => {
            const on = schedule.days.includes(d)
            return (
              <Press key={d} radius={20} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={DAY_SHORT[d]}
                onPress={() => {
                  if (on && schedule.days.length === 1) return // at least one day
                  haptic.tap()
                  onChange({ ...schedule, days: on ? schedule.days.filter((x) => x !== d) : [...schedule.days, d].sort() })
                }}
                style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.tube : c.panel2 }}>
                <Text variant="label" style={{ color: on ? c.onTube : c.ink3 }}>{DAY_SHORT[d].slice(0, 1)}</Text>
              </Press>
            )
          })}
        </View>
      )}
      {schedule.kind === 'time' && (
        <TimePicker label="At" hour={schedule.hour} minute={schedule.minute} onChange={(hour, minute) => onChange({ ...schedule, hour, minute })} />
      )}
      {schedule.kind === 'hours' && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">
          {EVERY_HOURS.map((n) => (
            <Chip key={n} label={n === 1 ? 'Every hour' : `Every ${n} hours`} selected={schedule.every === n}
              onPress={() => { haptic.tap(); onChange({ kind: 'hours', every: n }) }} />
          ))}
        </View>
      )}
      {schedule.kind !== 'custom' && (
        <View style={{ gap: 2 }} accessibilityLiveRegion="polite">
          <Text variant="footnote" color="ink2">Runs {describeSchedule(schedule)}, your time.</Text>
          {preview.length > 0 && <Text variant="footnote" color="ink3">Next: {preview.map((d) => whenLabel(d.toISOString())).join(' · ')}</Text>}
        </View>
      )}
    </View>
  )
}

function AppEventFields({ draft, onChange, apps, connected, events, eventsError }: {
  draft: AutomationDraft; onChange: (d: AutomationDraft) => void; apps: string[]; connected: Set<string>
  events: AppEvent[] | null; eventsError: string | null
}) {
  const [more, setMore] = useState(false)
  const ev = events?.find((e) => e.slug === draft.trigger)
  const appOptions: PickerOption[] = apps.map((t) => ({
    value: t, title: toolkitName(t), subtitle: connected.has(t) ? undefined : 'Not connected', leading: <BrandTile toolkit={t} size={32} />,
  }))
  const eventOptions: PickerOption[] = (events ?? []).map((e) => ({
    value: e.slug, title: eventTitle(e.name), subtitle: e.required.length ? `Needs ${e.required.map((k) => label(k.replace(/_?ids?$/i, '') || k).toLowerCase()).join(', ')}` : undefined,
  }))
  const pickEvent = (slug: string) => {
    const e = events?.find((x) => x.slug === slug)
    // Start from the event's defaults for what it needs; keep values the user already typed for the same keys.
    const defaults = Object.fromEntries(Object.entries(e?.defaults ?? {}).map(([k, v]) => [k, String(v)]))
    onChange({ ...draft, trigger: slug, settings: { ...defaults, ...Object.fromEntries(Object.entries(draft.settings).filter(([k]) => e?.settings[k] !== undefined)) } })
  }
  const optional = ev ? Object.keys(ev.settings).filter((k) => !ev.required.includes(k)) : []
  const field = (k: string, required: boolean) => (
    <SettingField key={`${draft.app}:${k}`} app={draft.app!} name={k} required={required} hint={ev?.settings[k]}
      value={draft.settings[k] ?? ''} onPick={(sets) => onChange({ ...draft, settings: { ...draft.settings, ...sets } })}
      fallback={textField(k, required)} />
  )
  const textField = (k: string, required: boolean) => (
    <TextField
      key={k}
      label={`${label(k)}${required ? '' : ' (optional)'}`}
      value={draft.settings[k] ?? ''}
      onChangeText={(v) => onChange({ ...draft, settings: { ...draft.settings, [k]: v } })}
      hint={ev?.settings[k] || undefined}
      keyboardType={ev?.types[k] === 'integer' || ev?.types[k] === 'number' ? 'number-pad' : 'default'}
      autoCapitalize="none"
      autoCorrect={false}
    />
  )
  return (
    <View style={{ gap: 12 }}>
      <PickerField label="App" value={draft.app} options={appOptions} placeholder="Pick an app"
        onChange={(t) => onChange({ ...draft, app: t, trigger: null, settings: {} })} intro="Apps this teammate can use." />
      {draft.app && !connected.has(draft.app) && (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Icon icon={AlertCircleIcon} size={16} color="warning" />
          <Text variant="footnote" color="ink2" style={{ flex: 1 }}>{toolkitName(draft.app)} isn’t connected, so its events can’t arrive. Connect it in Profile → Apps.</Text>
        </View>
      )}
      {draft.app && (
        eventsError ? <Text variant="footnote" color="danger">{eventsError}</Text>
          : events === null ? <Text variant="footnote" color="ink3">Loading {toolkitName(draft.app)}’s events…</Text>
            : events.length === 0 ? <Text variant="footnote" color="ink3">{toolkitName(draft.app)} doesn’t send events Tubelight can listen to. Try a schedule.</Text>
              : <PickerField label="Event" value={draft.trigger} options={eventOptions} onChange={pickEvent} placeholder="Pick what starts it" />
      )}
      {ev && ev.required.map((k) => field(k, true))}
      {ev && optional.length > 0 && (
        <>
          <Button label={more ? 'Fewer settings' : `More settings (${optional.length})`} size="sm" variant="ghost" onPress={() => setMore((m) => !m)} style={{ alignSelf: 'flex-start' }} />
          <Collapse open={more}><View style={{ gap: 12 }}>{optional.map((k) => field(k, false))}</View></Collapse>
        </>
      )}
      {ev && (
        <TextField label="Only when it mentions (optional)" value={draft.keywords} onChangeText={(v) => onChange({ ...draft, keywords: v })}
          placeholder="priya@acme.com, invoice" hint="Comma-separated. Every word must appear, or the run is skipped." autoCapitalize="none" autoCorrect={false} />
      )}
    </View>
  )
}

/** "Describe it" for a new automation: plain words in, the whole form filled out below, ready to adjust. */
/** Turns "every 2 hours, check my inbox…" into a filled draft (POST /automations/draft). Throws with the reason. */
export async function draftFromText(text: string, draft: AutomationDraft, allowed: string[]): Promise<{ draft: AutomationDraft; note: string }> {
  const d = await api<{
    name: string; instructions: string; kind: 'schedule' | 'app'; cron: string | null; app?: string; trigger: string | null
    settings: Record<string, unknown>; keywords: string[]; missing: string[]; apps: string[]; note: string
  }>('/automations/draft', { method: 'POST', json: { text: text.trim(), teammate_id: draft.teammateId, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } })
  // Least access: just the apps it needs (none for a pizza fact); all of them only when it needs all.
  const toolkits = allowed.every((t) => d.apps.includes(t)) ? null : d.apps.filter((t) => allowed.includes(t))
  return {
    draft: {
      ...draft, name: d.name || draft.name, instructions: d.instructions || draft.instructions, kind: d.kind, toolkits,
      schedule: d.cron ? parseCron(d.cron) : draft.schedule, app: d.app ?? null, trigger: d.trigger,
      settings: Object.fromEntries(Object.entries(d.settings ?? {}).map(([k, v]) => [k, String(v)])), keywords: d.keywords.join(', '),
    },
    note: d.note || (d.missing.length ? `Fill in ${d.missing.map(label).join(', ')} under Advanced.` : ''),
  }
}

/** A new automation, said in your own words: a big writing area and who does it. */
export function DescribeStep({ text, onText, teammateId, onTeammate }: {
  text: string; onText: (t: string) => void; teammateId: string | null; onTeammate: (id: string) => void
}) {
  const { c } = useTheme()
  const ws = useWorkspace()
  return (
    <View style={{ gap: 22 }}>
      <View style={{ gap: 6 }}>
        <Text variant="title">What should happen?</Text>
        <Text variant="body" color="ink2">Say it like you’d tell a person: when, what to look at, and what you want back.</Text>
      </View>
      <TextInput
        value={text}
        onChangeText={onText}
        multiline
        autoFocus
        maxLength={1000}
        placeholder="Every 2 hours, check my inbox and tell me what needs me"
        placeholderTextColor={c.ink4}
        cursorColor={c.tube}
        selectionColor={c.tubeGlow}
        textAlignVertical="top"
        style={{ minHeight: 120, padding: 0, fontFamily: fonts.regular, fontSize: 20, lineHeight: 28, letterSpacing: -0.3, color: c.ink }}
      />
      <View style={{ gap: 10 }}>
        <Text variant="overline" color="ink3">Who does it</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -20 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 4 }}>
          {ws.teammates.map((t) => {
            const on = teammateId === t.id
            return (
              <Press key={t.id} radius={14} static onPress={() => { haptic.tap(); onTeammate(t.id) }} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={t.name}
                style={{ alignItems: 'center', gap: 6, width: 68, paddingVertical: 4 }}>
                <View style={{ borderRadius: 26, padding: 2, borderWidth: 2, borderColor: on ? c.tube : 'transparent' }}>
                  <TeammateAvatar teammate={t} size={40} interactive={false} paused />
                </View>
                <Text variant="footnote" color={on ? 'ink' : 'ink3'} numberOfLines={1}>{t.name}</Text>
              </Press>
            )
          })}
        </ScrollView>
      </View>
    </View>
  )
}

/** What the teammate understood, in one sentence, before the form's details. */
export function Understood({ draft, events }: { draft: AutomationDraft; events: AppEvent[] | null }) {
  const ws = useWorkspace()
  const tm = ws.teammate(draft.teammateId)
  const where = draft.projectId ? ws.projects.find((p) => p.id === draft.projectId)?.name ?? 'the project' : `your chat with ${tm?.name ?? 'them'}`
  const apps = draft.toolkits === null ? (tm?.allowed_toolkits ?? []) : draft.toolkits
  return (
    <Surface padding={16} style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {tm && <TeammateAvatar teammate={tm} size={32} interactive={false} paused />}
        <Text variant="headline" style={{ flex: 1 }}>{draft.name || 'New automation'}</Text>
      </View>
      <Text variant="body" color="ink2">
        {tm?.name ?? 'Your teammate'} runs it {whenOf(draft, events)} and posts what it finds in {where}. With nothing new, it stays quiet.
      </Text>
      {apps.length > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text variant="footnote" color="ink3">Uses</Text>
          {apps.map((t) => <View key={t} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><BrandTile toolkit={t} size={18} /><Text variant="footnote" color="ink2">{toolkitName(t)}</Text></View>)}
        </View>
      )}
      <Text variant="footnote" color="ink3">Change any of it under Advanced.</Text>
    </Surface>
  )
}

/** An ID-like setting (a Linear team, a Gmail label, a GitHub repo): pick it by name from the account itself. Falls
 * back to typing it when there's no list for it or the lookup fails. */
const choiceCache: Record<string, { value: string; label: string; sets?: Record<string, string> }[] | 'none'> = {}
function SettingField({ app, name, required, hint, value, onPick, fallback }: {
  app: string; name: string; required: boolean; hint?: string; value: string
  onPick: (sets: Record<string, string>) => void; fallback: React.ReactNode
}) {
  const key = `${app}:${name}`
  const [opts, setOpts] = useState(choiceCache[key] ?? null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (choiceCache[key]) return
    let live = true
    api<{ value: string; label: string; sets?: Record<string, string> }[]>(`/apps/${app}/choices/${name}`).then(
      (l) => { choiceCache[key] = l; if (live) setOpts(l) },
      (e: Error) => {
        if (!live) return
        if (/no list|not found/i.test(e.message)) { choiceCache[key] = 'none'; setOpts('none') } else setFailed(e.message)
      },
    )
    return () => { live = false }
  }, [app, name, key])
  if (opts === 'none' || failed) {
    return <View style={{ gap: 4 }}>{fallback}{failed && <Text variant="footnote" color="ink3">Couldn’t list them ({failed}); type it instead.</Text>}</View>
  }
  const title = `${label(name.replace(/_?ids?$/i, '') || name)}${required ? '' : ' (optional)'}`
  return (
    <View style={{ gap: 6 }}>
      <Text variant="label" color="ink3" style={{ paddingLeft: 2 }}>{title}</Text>
      <PickerField
        label={title}
        value={value || null}
        placeholder={opts === null ? 'Looking them up…' : opts.length ? `Pick a ${label(name.replace(/_?ids?$/i, '')).toLowerCase()}` : 'None found in your account'}
        disabled={!opts?.length}
        options={(opts ?? []).map((o) => ({ value: o.value, title: o.label }))}
        onChange={(v) => { const o = (opts || []).find((x) => x.value === v); onPick(o?.sets ?? { [name]: v }) }}
        intro={hint}
      />
    </View>
  )
}
