// Garage: the crew's home base. A blue summary card says how the day went (who did what, what needs you, who is
// working, what's next) with the day's highlights under it (what automations found, to-dos due); every number in it
// opens the runs behind it. Then: what needs you, today's runs as receipts, who is working now, what's coming up
// (each opens a summary sheet) and the automations behind it. Every step of every run is in All activity (/activity).
// `?demo=busy` or `?demo=calm` fills it with sample data to judge the layout.
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { setStatusBarStyle } from 'expo-status-bar'
import { LinearGradient } from 'expo-linear-gradient'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Text as RNText, RefreshControl, ScrollView, View } from 'react-native'
import Animated, { interpolate, runOnJS, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Add01Icon, ArrowDown01Icon, ArrowUp01Icon, BellRingIcon, ArrowRight01Icon, BrowserIcon, Calendar03Icon, CheckmarkCircle02Icon,
  CodeIcon, Globe02Icon, LaptopIcon, WorkflowIcon, WorkHistoryIcon,
} from '@hugeicons/core-free-icons'

import { ApprovalCard } from '@/components/approval-card'
import { AutomationRows, lastRun } from '@/components/automation-rows'
import { BrandTile } from '@/components/brand-mark'
import { useTabBarInset } from '@/components/tab-bar'
import { describe, isShown } from '@/lib/activity'
import { api } from '@/lib/api'
import { openAutomation, runNow, useAutomations, whenText, type Automation } from '@/lib/automations'
import { useTodayEvents, type PhoneEvent } from '@/lib/calendar'
import { finishReminder, reminderNext, REPEATS, useReminders, type Reminder } from '@/lib/clock'
import { ago, clock, whenLabel } from '@/lib/format'
import { liveChannel } from '@/lib/realtime'
import { supabase } from '@/lib/supabase'
import { dueLabel, isoDay, useFollowups, useTodos, type Followup, type Todo } from '@/lib/tasks'
import type { Activity, Approval, Run, Teammate } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { fonts, radius, useTheme } from '@/theme'
import { ShimmerText } from '@/ui/shimmer-text'
import {
  AvatarGroup, Button, Icon, Squircle, ListRow, Markdown, Press, Sheet, Skeleton, Surface, TeammateAvatar, Text,
  haptic,
} from '@/ui'

/** GET /garage/runs: a finished run. */
interface Receipt {
  run_id: string
  thread_id: string
  teammate_id: string | null
  trigger: Run['trigger']
  automation_id: string | null
  /** The automation's name; null for follow-ups, events and chats. */
  title: string | null
  outcome: 'posted' | 'quiet' | 'failed' | 'cancelled'
  steps: number
  /** Where it worked: app toolkits ("gmail") or web, browser, computer, code. */
  apps: string[]
  duration_ms: number | null
  at: string
  /** The reply's first line (automation runs lead with a headline); null unless it posted. */
  headline: string | null
  /** What it said (or why it failed). */
  text: string
}

interface Live { run: Run; doing?: string }

/** What a sheet of runs shows: every run today, or one outcome. */
type Jobs = 'all' | 'posted' | 'quiet' | 'failed'

const BLUE = ['#3f7cff', '#1f50e3'] as const
const BLUE_MID = '#2f66f1' // behind inline faces, so their rings melt into the card
const DIM = 'rgba(255,255,255,0.6)'
const SHOWN = 4 // receipts before "Show more"
const NONE: Receipt[] = []

const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() }
const newAutomation = () => router.push({ pathname: '/automation/[id]', params: { id: 'new' } })
const openChat = (threadId: string) => router.push({ pathname: '/chat/[threadId]', params: { threadId } })
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (xs: string[]) => (xs.length < 2 ? xs.join('') : xs.length > 3
  ? `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more` : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** Markdown to plain sentences for previews. */
const plain = (s: string) => s
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_`>#~]/g, '')
  .replace(/^\s*[-+]\s+/gm, '')
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => (/[.!?:…]$/.test(l) ? l : `${l}.`)).join(' ')
  .replace(/\s+/g, ' ')

const PLACE: Record<string, { label: string; icon: typeof Globe02Icon }> = {
  web: { label: 'the web', icon: Globe02Icon },
  browser: { label: 'the browser', icon: BrowserIcon },
  computer: { label: 'your computer', icon: LaptopIcon },
  code: { label: 'code', icon: CodeIcon },
}
const NAMES: Record<string, string> = { github: 'GitHub', googlecalendar: 'Google Calendar', googledrive: 'Google Drive', googlesheets: 'Google Sheets', googledocs: 'Google Docs', linkedin: 'LinkedIn', youtube: 'YouTube' }
const placeName = (p: string) => PLACE[p]?.label ?? NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1)
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const took = (ms: number | null) => (ms === null ? null : ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`)

function PlaceTile({ place, size, onBlue }: { place: string; size: number; onBlue?: boolean }) {
  const { c } = useTheme()
  const p = PLACE[place]
  if (!p) return <BrandTile toolkit={place} size={size} />
  return (
    <Squircle style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: onBlue ? '#fff' : c.panel2, borderWidth: 1, borderColor: onBlue ? 'transparent' : c.line, alignItems: 'center', justifyContent: 'center' }}>
      <Icon icon={p.icon} size={Math.round(size * 0.58)} color={onBlue ? BLUE[1] : 'ink2'} />
    </Squircle>
  )
}

const places = (xs: string[], size: number, ring?: string) => (
  <AvatarGroup size={size} max={ring ? 6 : 4} ring={ring} items={xs.map((p) => ({ key: p, name: placeName(p), render: (s) => <PlaceTile place={p} size={s} onBlue={!!ring} /> }))} />
)

export default function GarageTab() {
  const { c, scheme } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const insets = useSafeAreaInsets()
  const { demo } = useLocalSearchParams<{ demo?: string }>()
  const autos = useAutomations()
  const follow = useFollowups()
  const { todos } = useTodos()
  const reminders = useReminders().rows
  const events = useTodayEvents()
  const [receipts, setReceipts] = useState<Receipt[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const [focused, setFocused] = useState(true)
  const [jobs, setJobs] = useState<Jobs | null>(null)
  const [one, setOne] = useState<Receipt | null>(null)
  const [later, setLater] = useState<Upcoming | null>(null)
  const closeJobs = useCallback(() => setJobs(null), [])
  const closeOne = useCallback(() => setOne(null), [])
  const closeLater = useCallback(() => setLater(null), [])
  const [watching, setWatching] = useState<Live | null>(null)
  const closeWatching = useCallback(() => setWatching(null), [])
  const [cal, setCal] = useState(false)
  const openRun = useCallback((r: Receipt) => { setJobs(null); setOne(r) }, [])
  const onUpcoming = useCallback((u: Upcoming) => setLater(u), [])

  // Past the blue card the page shows under the clock: a canvas-coloured strip fades in there and the status bar
  // icons go back to the theme's.
  const scroller = useAnimatedRef<Animated.ScrollView>()
  const y = useSharedValue(0)
  const heroH = useSharedValue(400)
  const past = useSharedValue(false)
  const needsY = useRef(0)
  const barFor = useCallback((over: boolean) => setStatusBarStyle(over && scheme !== 'dark' ? 'dark' : 'light'), [scheme])
  const onScroll = useAnimatedScrollHandler((e) => {
    y.set(e.contentOffset.y)
    const over = e.contentOffset.y > heroH.get() - insets.top
    if (over !== past.get()) { past.set(over); runOnJS(barFor)(over) }
  })
  const scrim = useAnimatedStyle(() => ({ opacity: interpolate(y.get(), [heroH.get() - insets.top - 24, heroH.get() - insets.top], [0, 1], 'clamp') }))

  // Unchanged runs keep the same array, so nothing re-renders when a refresh finds nothing new.
  const loadReceipts = useCallback(() => api<Receipt[]>(`/garage/runs?since=${encodeURIComponent(midnight())}`)
    .then((rs) => {
      const next = rs.map((r) => ({ ...r, apps: r.apps ?? [], text: r.text ?? '', headline: r.headline ?? null }))
      setReceipts((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }, () => setReceipts((r) => r ?? [])), [])
  // Refresh after the tab has slid in: work during the slide drops its frames.
  useFocusEffect(useCallback(() => {
    const t = setTimeout(loadReceipts, 400)
    setFocused(true)
    setStatusBarStyle(past.get() && scheme !== 'dark' ? 'dark' : 'light')
    return () => { clearTimeout(t); setFocused(false); setStatusBarStyle(scheme === 'dark' ? 'light' : 'dark') }
  }, [loadReceipts, scheme, past]))

  useEffect(() => {
    supabase.from('profiles').select('display_name').single().then(({ data }) => {
      const n = (data as { display_name?: string } | null)?.display_name
      if (n) setName(n.split(' ')[0])
      else supabase.auth.getSession().then(({ data: s }) => {
        const m = s.session?.user.user_metadata
        const g = (m?.full_name ?? m?.name) as string | undefined
        if (g) setName(g.split(' ')[0])
      })
    })
  }, [])

  // A run that just finished becomes a receipt (and may have changed an automation's last run).
  const running = useMemo(() => ws.liveRuns.filter((r) => r.status === 'running'), [ws.liveRuns])
  const count = useRef(running.length)
  useEffect(() => {
    if (running.length < count.current) { loadReceipts(); autos.load() }
    count.current = running.length
  }, [running.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const doing = useDoing(running, ws.teammate)

  const refresh = async () => {
    setRefreshing(true)
    await Promise.all([loadReceipts(), autos.load(), follow.refresh(), ws.refresh()])
    setRefreshing(false)
  }

  const mode = demo === 'calm' ? 'calm' : demo ? 'busy' : null
  const sample = useMemo(() => (mode ? sampleData(ws.teammates, mode) : null), [mode, ws.teammates])
  const live = useMemo(() => running.map((run) => ({ run, doing: doing[run.id] })), [running, doing])
  const real = useMemo(() => ({
    receipts, automations: autos.list, followups: follow.pending, done: follow.done, approvals: ws.pendingApprovals, live,
    todos: todos ?? [], reminders: reminders ?? [], events: events ?? [],
  }), [receipts, autos.list, follow.pending, follow.done, ws.pendingApprovals, live, todos, reminders, events])
  const d = sample ?? real

  // Automations that can't work or stopped on their own need you as much as an approval does.
  const broken = useMemo(() => (d.automations ?? []).filter((a) => a.problems.length
    || (!a.enabled && (a.recent ?? []).length >= 3 && a.recent!.slice(0, 3).every((o) => o === 'failed'))), [d.automations])
  const upcoming = useMemo(() => comingUp(d.automations, d.followups, d.reminders, d.events), [d.automations, d.followups, d.reminders, d.events])
  const due = useMemo(() => (d.todos as Todo[]).filter((t) => t.due && t.status !== 'done' && t.status !== 'canceled' && t.due <= isoDay(new Date())), [d.todos])
  const onHeight = useCallback((h: number) => heroH.set(h), [heroH])
  const onNeeds = useCallback(() => scroller.current?.scrollTo({ y: needsY.current - insets.top - 8, animated: true }), [scroller, insets.top])
  const onChanged = useCallback(() => { autos.load(); follow.refresh() }, [autos, follow])
  const needs = d.approvals.length + broken.length

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <Animated.ScrollView
        ref={scroller}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: inset + 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
      >
        <Hero
          onHeight={onHeight}
          name={name}
          receipts={d.receipts}
          needs={needs}
          live={d.live}
          next={upcoming[0]}
          due={due}
          mode={mode}
          onJobs={setJobs}
          onReceipt={setOne}
          events={d.events}
          onEvents={() => setCal(true)}
          onNeeds={onNeeds}
          onNext={onUpcoming}
        />

        {needs > 0 && (
          <View onLayout={(e) => { needsY.current = e.nativeEvent.layout.y }}>
            <Section title="Needs you">
              <View style={{ gap: 16 }}>
                {d.approvals.map((a) => <Waiting key={a.id} approval={a} />)}
                {broken.length > 0 && (
                  <Surface style={{ overflow: 'hidden', marginHorizontal: 16 }}>
                    {broken.map((a) => (
                      <ListRow
                        key={a.id}
                        title={a.name}
                        subtitle={a.problems[0] ?? 'Paused itself after failing 3 runs in a row. Open it to see why.'}
                        subtitleLines={2}
                        chevron
                        onPress={() => openAutomation(a.id)}
                      />
                    ))}
                  </Surface>
                )}
              </View>
            </Section>
          </View>
        )}

        <Section title="Today">
          <Today receipts={d.receipts} onOpen={openRun} />
        </Section>

        <Section title={d.live.length ? `Working now · ${d.live.length}` : 'Working now'}>
          <WorkingNow live={d.live} animate={focused} onOpen={setWatching} />
        </Section>

        <Section title="Coming up">
          <ComingUp items={upcoming} loading={d.automations === null || d.followups === null} onOpen={onUpcoming} onFollowups={() => router.push('/followups')} />
        </Section>

        <Section
          title="Automations"
          right={<Press radius={8} static onPress={newAutomation} accessibilityLabel="New automation" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, minHeight: 36 }}>
            <Icon icon={Add01Icon} size={16} color="ink2" /><Text variant="label" color="ink2">New</Text>
          </Press>}
        >
          <View style={{ paddingHorizontal: 16 }}>
            {d.automations === null ? (
              <Surface padding={16} style={{ gap: 10 }}><Skeleton width="60%" /><Skeleton width="40%" /></Surface>
            ) : d.automations.length === 0 ? (
              <Surface>
                <ListRow
                  leading={<View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}><Icon icon={WorkflowIcon} size={16} color="tube" /></View>}
                  title="Nothing runs on its own yet"
                  subtitle="Describe one, or ask a teammate: “every morning at 8, brief me on new mail”."
                  subtitleLines={2}
                  chevron
                  onPress={newAutomation}
                />
              </Surface>
            ) : (
              <AutomationRows items={d.automations} show="who" onToggle={sample ? () => {} : autos.toggle} />
            )}
          </View>
        </Section>

        <View style={{ paddingHorizontal: 16 }}>
          <Surface>
            <ListRow title="All activity" subtitle="Every step teammates took, as it happened" icon={WorkHistoryIcon} chevron onPress={() => router.push('/activity')} />
          </Surface>
        </View>
      </Animated.ScrollView>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top, backgroundColor: c.canvas }, scrim]} />

      <JobsSheet which={jobs} receipts={d.receipts ?? NONE} onClose={closeJobs} onOpen={openRun} />
      <RunSheet r={one} onClose={closeOne} />
      <WorkingSheet l={watching} sample={!!sample} onClose={closeWatching} />
      <EventsSheet open={cal} events={d.events} onClose={() => setCal(false)} />
      <UpcomingSheet item={later} receipts={d.receipts ?? NONE} sample={!!sample} onClose={closeLater} onChanged={onChanged} />
    </View>
  )
}

// ---------------------------------------------------------------------------------------------------------------- hero

/** A bright phrase in the hero; tappable ones open what they count. */
function B({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  return <RNText onPress={onPress} suppressHighlighting style={{ color: '#fff' }}>{children}</RNText>
}

/** The day in one sentence, its highlights, and the outcome counts; every number opens what's behind it. */
const Hero = memo(function Hero({ name, receipts, needs, live, next, due, events, mode, onHeight, onJobs, onReceipt, onNeeds, onNext, onEvents }: {
  name: string | null; receipts: Receipt[] | null; needs: number; live: Live[]; next?: Upcoming; due: Todo[]
  events: PhoneEvent[]; onEvents: () => void
  mode: 'busy' | 'calm' | null; onHeight: (h: number) => void; onJobs: (j: Jobs) => void; onReceipt: (r: Receipt) => void
  onNeeds: () => void; onNext: (u: Upcoming) => void
}) {
  const insets = useSafeAreaInsets()
  const ws = useWorkspace()
  const hour = new Date().getHours()
  const hello = hour < 5 ? 'Up late' : hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'
  const done = receipts ?? []
  const crew = [...new Set(done.map((r) => r.teammate_id).filter((x): x is string => !!x))]
    .map((id) => ws.teammate(id)).filter((t): t is Teammate => !!t)
  const counts = { posted: 0, quiet: 0, failed: 0 }
  for (const r of done) if (r.outcome in counts) counts[r.outcome as keyof typeof counts]++
  const worked = [...new Set(done.flatMap((r) => r.apps))]
  const busy = [...new Map(live.map((l) => [l.run.teammate_id, ws.teammate(l.run.teammate_id)])).values()].filter((t): t is Teammate => !!t)
  // What automations found today: each one's latest headline.
  const found = [...new Map([...done].reverse().filter((r) => r.automation_id && r.outcome === 'posted' && r.headline)
    .map((r) => [r.automation_id, r])).values()].reverse().slice(0, 3)
  const overdue = due.filter((t) => dueLabel(t.due!).overdue)

  return (
    <View onLayout={(e) => onHeight(e.nativeEvent.layout.height)} style={{ marginBottom: 20 }}>
      {/* The gradient rounds its own corners: clipping a wrapper (overflow hidden) costs a layer on every frame. */}
      <LinearGradient colors={BLUE} start={{ x: 0, y: 0 }} end={{ x: 0.4, y: 1 }} style={{ paddingTop: insets.top + 10, paddingHorizontal: 20, paddingBottom: 16, borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, marginBottom: 14, gap: 6 }}>
          <Text style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 17, color: '#fff' }} accessibilityRole="header">Garage</Text>
          {mode && (['busy', 'calm', 'hide'] as const).map((m) => (
            <Press key={m} radius={radius.pill} static onPress={() => router.setParams({ demo: m === 'hide' ? undefined : m })}
              style={{ paddingHorizontal: 10, minHeight: 28, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: mode === m ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)' }}>
              <Text variant="label" style={{ color: '#fff' }}>{m === 'busy' ? 'Busy day' : m === 'calm' ? 'Calm day' : 'Hide'}</Text>
            </Press>
          ))}
        </View>

        {receipts === null ? (
          <View style={{ gap: 12, paddingVertical: 6 }}>
            {[0.9, 0.75, 0.55].map((w) => <View key={w} style={{ height: 22, width: `${w * 100}%`, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.14)' }} />)}
          </View>
        ) : (
          <Text style={{ fontFamily: fonts.semibold, fontSize: 23, lineHeight: 32, letterSpacing: -0.45, color: DIM }}>
            {hello}{name ? <>, <B>{name}</B></> : null}. {crew.length ? (
              <>Your crew <Faces people={crew} /> finished <B onPress={() => onJobs('all')}>{plural(done.length, 'job')}</B> today</>
            ) : <>Nothing has run yet today</>}
            {needs > 0 ? <>, and <Dot /> <B onPress={onNeeds}>{needs} {needs === 1 ? 'needs' : 'need'} you</B>.</> : <>. <B>Nothing needs you</B> right now.</>}
            {busy.length ? (
              <> <Faces people={busy} /> <B>{names(busy.map((t) => t.name))}</B> {busy.length > 1 ? 'are' : 'is'} working right now.</>
            ) : null}
            {next ? <> Next up <Chip icon={next.reminder ? BellRingIcon : next.auto ? WorkflowIcon : Calendar03Icon} /> <B onPress={() => onNext(next)}>{next.title}</B> {next.day.toLowerCase() === 'today' ? 'at' : next.day.toLowerCase()} <B>{next.time}</B>.</> : null}
            {found.map((r) => (
              <RNText key={r.run_id}> <Chip tile={r.apps[0] ? <PlaceTile place={r.apps[0]} size={28} onBlue /> : undefined} icon={WorkflowIcon} /> {r.title ?? 'An automation'} found <B onPress={() => onReceipt(r)}>{lowerFirst(r.headline!.replace(/[.\s]+$/, ''))}</B>.</RNText>
            ))}
            {due.length > 0 && (
              <> <Chip icon={CheckmarkCircle02Icon} /> <B onPress={() => router.navigate('/tasks')}>{plural(due.length, 'to-do')}</B> {due.length === 1 ? 'is' : 'are'} due{overdue.length ? <>, <B onPress={() => router.navigate('/tasks')}>{overdue.length} overdue</B></> : ' today'}: {due.length > 2 ? `${due.slice(0, 2).map((t) => t.title).join(', ')} and ${due.length - 2} more` : list(due.map((t) => t.title))}.</>
            )}
            {events.length > 0 && (events.length === 1
              ? <> <Chip icon={Calendar03Icon} /> <B onPress={onEvents}>{events[0].title || 'An event'}</B> {events[0].allDay ? 'is on your calendar today' : <>is on your calendar at <B onPress={onEvents}>{clock(new Date(events[0].start))}</B></>}.</>
              : <> <Chip icon={Calendar03Icon} /> <B onPress={onEvents}>{events.length} events</B> are on your calendar today.</>)}
          </Text>
        )}

        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 16, marginBottom: 10 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 }}>
          <Stat n={counts.posted} label="posted" onPress={() => onJobs('posted')} />
          <Stat n={counts.quiet} label="quiet" onPress={() => onJobs('quiet')} />
          {counts.failed > 0 && <Stat n={counts.failed} label="failed" onPress={() => onJobs('failed')} />}
          <View style={{ flex: 1 }} />
          {worked.length > 0 && places(worked, 20, BLUE[1])}
        </View>
      </LinearGradient>
    </View>
  )
})

function Faces({ people }: { people: Teammate[] }) {
  return (
    <View style={{ transform: [{ translateY: 6 }] }}>
      <AvatarGroup size={24} max={6} ring={BLUE_MID} items={people.map((t) => ({ key: t.id, name: t.name, render: (s) => <TeammateAvatar teammate={t} size={s} interactive={false} paused /> }))} />
    </View>
  )
}

/** A white tile sitting inline in the hero sentence: an icon, or an app's logo. */
function Chip({ icon, tile }: { icon: typeof Calendar03Icon; tile?: ReactNode }) {
  return (
    <View style={{ transform: [{ translateY: 5 }] }}>
      <Squircle style={{ width: 28, height: 28, borderRadius: 9, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {tile ?? <Icon icon={icon} size={17} color={BLUE[1]} strokeWidth={2} />}
      </Squircle>
    </View>
  )
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) && !/^[A-Z][a-z]+ [A-Z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s)

function Dot() {
  return <View style={{ transform: [{ translateY: -3 }], width: 9, height: 9, borderRadius: 5, backgroundColor: '#ffb020' }} />
}

/** An outcome count; tap to see those runs. */
function Stat({ n, label, onPress }: { n: number; label: string; onPress: () => void }) {
  return (
    <Press radius={radius.pill} static onPress={onPress} disabled={!n} accessibilityLabel={`${n} ${label}. Show them`}
      style={{ justifyContent: 'center', paddingHorizontal: 12, minHeight: 30, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.12)' }}>
      <Text variant="label" style={{ color: '#fff' }}>{n} {label}</Text>
    </Press>
  )
}

// ------------------------------------------------------------------------------------------------------------ sections

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ paddingBottom: 28 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, minHeight: 36, paddingBottom: 6 }}>
        <Text variant="headline" accessibilityRole="header" style={{ flex: 1 }}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  )
}

function Waiting({ approval }: { approval: Approval }) {
  const ws = useWorkspace()
  const title = ws.threadTitle(approval.thread_id)
  return (
    <View style={{ paddingHorizontal: 16, gap: 6 }}>
      <Press
        radius={8}
        static
        onPress={() => openChat(approval.thread_id)}
        accessibilityLabel={`Open ${title}`}
        outerStyle={{ alignSelf: 'flex-start', marginLeft: -6 }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, minHeight: 32 }}
      >
        <Text variant="footnote" color="ink3">{approval.thread_id.startsWith('dm:') ? `Chat with ${title}` : title}</Text>
        <Icon icon={ArrowRight01Icon} size={14} color="ink3" />
      </Press>
      <ApprovalCard approval={approval} teammate={ws.teammate(approval.teammate_id)} onDecided={ws.refresh} />
    </View>
  )
}

function Hairline({ inset = 0 }: { inset?: number }) {
  const { c } = useTheme()
  return <View style={{ height: 1, marginLeft: inset, backgroundColor: c.line }} />
}

/** Today's runs as a timeline, newest first: the time on the left, faces on a thin rail, what came of each run beside
 * them. Quiet runs sit back; a failed one says why in red. Tap one for the whole reply. */
const Today = memo(function Today({ receipts, onOpen }: { receipts: Receipt[] | null; onOpen: (r: Receipt) => void }) {
  const [all, setAll] = useState(false)
  if (receipts === null) {
    return <View style={{ paddingHorizontal: 20, gap: 14 }}><Skeleton width="70%" /><Skeleton width="50%" /></View>
  }
  if (!receipts.length) {
    return <Text variant="body" color="ink3" style={{ paddingHorizontal: 20 }}>Nothing has finished yet today. Runs land here with what came of them.</Text>
  }
  const shown = all ? receipts : receipts.slice(0, SHOWN)
  const more = receipts.length - SHOWN
  return (
    <View style={{ paddingHorizontal: 16 }}>
      <Timeline receipts={shown} onOpen={onOpen} />
      {more > 0 && (
        <Press radius={10} static onPress={() => { haptic.tap(); setAll((x) => !x) }} outerStyle={{ alignSelf: 'flex-start', marginLeft: 96 }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, minHeight: 36 }}>
          <Text variant="label" color="ink2">{all ? 'Show less' : `${more} earlier today`}</Text>
          <Icon icon={all ? ArrowUp01Icon : ArrowDown01Icon} size={14} color="ink3" />
        </Press>
      )}
    </View>
  )
})

function Timeline({ receipts, onOpen }: { receipts: Receipt[]; onOpen: (r: Receipt) => void }) {
  return receipts.map((r, i) => <Moment key={r.run_id} r={r} last={i === receipts.length - 1} onOpen={onOpen} />)
}

/** What a run is called: its automation, or what woke it. */
const runTitle = (r: Receipt, threadTitle: (id: string) => string) => r.title ?? (r.trigger === 'schedule' ? 'Scheduled'
  : r.trigger === 'event' ? 'Event' : r.thread_id.startsWith('dm:') ? 'Asked by you' : threadTitle(r.thread_id))

const Moment = memo(function Moment({ r, last, onOpen }: { r: Receipt; last: boolean; onOpen: (r: Receipt) => void }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const tm = ws.teammate(r.teammate_id)
  const what = runTitle(r, ws.threadTitle)
  const where = r.apps.map(placeName)
  const quiet = r.outcome === 'quiet' || r.outcome === 'cancelled'
  const said = r.outcome === 'quiet' ? (where.length ? `Checked ${list(where)}, nothing new.` : 'Nothing new.')
    : r.outcome === 'cancelled' ? 'Stopped before it finished.'
      : r.outcome === 'failed' ? `Couldn’t finish${r.text ? `: ${plain(r.text)}` : '.'}`
        : r.headline || plain(r.text)
  // The first line (time, title) is centred on the 30 px face: 30 - 22 (title line) = 8, half above.
  return (
    <Press radius={14} static onPress={() => onOpen(r)} accessibilityLabel={`${clock(new Date(r.at))}. ${what}, ${tm?.name ?? 'a teammate'}. ${said}`}
      accessibilityHint="Shows the whole reply" style={{ flexDirection: 'row', gap: 12, opacity: quiet ? 0.62 : 1 }}>
      <Text variant="footnote" color="ink3" tabular numberOfLines={1} style={{ width: 62, textAlign: 'right', marginTop: 7 }}>{clock(new Date(r.at))}</Text>
      <View style={{ alignItems: 'center', width: 30 }}>
        {tm ? <TeammateAvatar teammate={tm} size={30} interactive={false} paused /> : <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.panel2 }} />}
        {r.outcome === 'failed' && <View style={{ position: 'absolute', top: 0, right: -1, width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger, borderWidth: 2, borderColor: c.canvas }} />}
        {!last && <View style={{ flex: 1, width: 1.5, marginTop: 6, borderRadius: 1, backgroundColor: c.line }} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, marginTop: 4, paddingBottom: last ? 4 : 22, gap: 3 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{what}<Text variant="body" color="ink3"> · {tm?.name ?? 'A teammate'}</Text></Text>
        <Text variant="body" color={r.outcome === 'failed' ? 'danger' : 'ink2'} numberOfLines={quiet ? 1 : 2}>{said}</Text>
        {r.outcome === 'posted' && r.apps.length > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 3 }}>
            {places(r.apps, 16, undefined)}
            <Text variant="footnote" color="ink3" tabular>{[r.steps ? plural(r.steps, 'step') : null, took(r.duration_ms)].filter(Boolean).join(' · ')}</Text>
          </View>
        )}
      </View>
    </Press>
  )
})

/** The runs behind a number in the hero, as the same timeline. */
function JobsSheet({ which, receipts, onClose, onOpen }: { which: Jobs | null; receipts: Receipt[]; onClose: () => void; onOpen: (r: Receipt) => void }) {
  const [last, setLast] = useState<Jobs>('all')
  if (which && which !== last) setLast(which)
  const shown = last === 'all' ? receipts : receipts.filter((r) => r.outcome === last)
  const title = last === 'all' ? `${plural(shown.length, 'job')} today`
    : last === 'posted' ? `${shown.length} posted: they had something to tell you`
      : last === 'quiet' ? `${shown.length} quiet: checked, nothing new` : `${shown.length} failed`
  return (
    <Sheet open={!!which} onClose={onClose} title={title}>
      <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 }}>
        <Timeline receipts={shown} onOpen={onOpen} />
      </ScrollView>
    </Sheet>
  )
}

/** One run, whole: who and what at the top, the reply full width, where it worked, and the way into its chat. */
function RunSheet({ r, onClose }: { r: Receipt | null; onClose: () => void }) {
  const ws = useWorkspace()
  const [last, setLast] = useState<Receipt | null>(null)
  if (r && r !== last) setLast(r)
  const x = r ?? last
  const tm = ws.teammate(x?.teammate_id)
  const where = x ? x.apps.map(placeName) : []
  const meta = x ? [where.length ? `Worked in ${list(where)}` : null, x.steps ? plural(x.steps, 'step') : null, took(x.duration_ms)].filter(Boolean).join(' · ') : ''
  return (
    <Sheet open={!!r} onClose={onClose} accessibilityLabel={x ? runTitle(x, ws.threadTitle) : 'Run'}>
      {x && (
        <View style={{ paddingHorizontal: 20, gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 4 }}>
            {tm && <TeammateAvatar teammate={tm} size={40} interactive={false} paused />}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="headline" numberOfLines={1}>{runTitle(x, ws.threadTitle)}</Text>
              <Text variant="caption" color="ink3" numberOfLines={1}>{tm?.name ?? 'A teammate'}</Text>
            </View>
            <Text variant="footnote" color="ink3" tabular>{clock(new Date(x.at))}</Text>
          </View>
          <ScrollView style={{ maxHeight: 440 }}>
            {x.outcome === 'posted' ? <Markdown value={x.text} /> : (
              <Text variant="body" color={x.outcome === 'failed' ? 'danger' : 'ink2'}>
                {x.outcome === 'quiet' ? (where.length ? `Checked ${list(where)}. Nothing new, so it stayed quiet.` : 'Nothing new, so it stayed quiet.')
                  : x.outcome === 'cancelled' ? 'Stopped before it finished.' : `Couldn’t finish${x.text ? `: ${plain(x.text)}` : '.'}`}
              </Text>
            )}
          </ScrollView>
          {!!meta && <Text variant="footnote" color="ink3">{meta}</Text>}
          <View style={{ gap: 4 }}>
            <Button label="Open in chat" size="lg" fullWidth onPress={() => { onClose(); openChat(x.thread_id) }} />
            {x.automation_id && x.outcome === 'failed' && (
              <Button label="Try again" variant="ghost" fullWidth onPress={() => { onClose(); runNow({ id: x.automation_id!, name: x.title ?? 'it' } as Automation) }} />
            )}
          </View>
        </View>
      )}
    </Sheet>
  )
}

/** What each running run is doing this moment: its latest step, live. */
function useDoing(runs: Run[], teammate: (id: string | null | undefined) => Teammate | undefined) {
  const [doing, setDoing] = useState<Record<string, string>>({})
  const ids = runs.map((r) => r.id).join(',')
  const sentence = useCallback((a: Activity) => describe(a, (id) => teammate(id)?.name), [teammate])
  useEffect(() => {
    if (!ids) return
    supabase.from('activity').select('*').in('run_id', ids.split(',')).order('created_at', { ascending: false }).limit(30)
      .then(({ data }) => {
        const latest: Record<string, string> = {}
        for (const a of (data ?? []) as Activity[]) if (a.run_id && !latest[a.run_id] && isStep(a)) latest[a.run_id] = sentence(a)
        setDoing(latest)
      })
    const live = liveChannel(() => supabase
      .channel(`garage-now:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity' }, (e) => {
        const a = e.new as Activity
        if (a.run_id && ids.includes(a.run_id) && isStep(a)) setDoing((d) => ({ ...d, [a.run_id!]: sentence(a) }))
      }), () => {})
    return () => live.stop()
  }, [ids, sentence])
  return doing
}

const isStep = (a: Activity) => a.type !== 'run_start' && a.type !== 'run_end' && a.type !== 'event' && isShown(a)

/** Who is working: their face, where, and their latest step with a light sweeping through it while on screen.
 * Tap one to watch its steps. */
const WorkingNow = memo(function WorkingNow({ live, animate, onOpen }: { live: Live[]; animate: boolean; onOpen: (l: Live) => void }) {
  const ws = useWorkspace()
  if (!live.length) return <Text variant="body" color="ink3" style={{ paddingHorizontal: 20 }}>Everyone’s free. Runs show here, step by step, while they happen.</Text>
  return (
    <Surface style={{ marginHorizontal: 16, overflow: 'hidden' }}>
      {live.map((l, i) => {
        const { run, doing } = l
        const tm = ws.teammate(run.teammate_id)
        const where = run.thread_id.startsWith('dm:') ? 'Direct chat' : ws.threadTitle(run.thread_id)
        const step = doing ? `Just ${doing}` : 'Getting started…'
        return (
          <View key={run.id}>
            {i > 0 && <Hairline />}
            <Press static onPress={() => onOpen(l)} accessibilityLabel={`${tm?.name ?? 'A teammate'} is working in ${where}. ${step}`} accessibilityHint="Shows its steps"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 }}>
              {tm ? <TeammateAvatar teammate={tm} size={36} interactive={false} /> : <View style={{ width: 36 }} />}
              <View style={{ flex: 1, minWidth: 0, gap: 2, overflow: 'hidden' }}>
                <Text variant="bodyMedium" numberOfLines={1}>{tm?.name ?? 'A teammate'}<Text variant="body" color="ink3"> · {where}</Text></Text>
                {animate ? <ShimmerText text={step} size={14} /> : <Text variant="caption" color="ink3" numberOfLines={1}>{step}</Text>}
              </View>
              <Icon icon={ArrowRight01Icon} size={16} color="ink3" />
            </Press>
          </View>
        )
      })}
    </Surface>
  )
})

/** A run as it happens: every step so far (live), the newest shimmering, and the way into its chat. */
function WorkingSheet({ l, sample, onClose }: { l: Live | null; sample: boolean; onClose: () => void }) {
  const ws = useWorkspace()
  const [last, setLast] = useState<Live | null>(null)
  if (l && l !== last) setLast(l)
  const x = l ?? last
  const [real, setSteps] = useState<{ id: string; text: string; at: string }[]>([])
  const began = x?.run.started_at
  const fake = useMemo(() => SAMPLE_STEPS.map((t, i) => ({ id: `${i}`, text: t, at: new Date(new Date(began ?? 0).getTime() + i * 15000).toISOString() })), [began])
  const steps = sample ? fake : real
  const id = x?.run.id
  useEffect(() => {
    if (!id || !l || sample) return
    const say = (a: Activity) => ({ id: a.id, text: describe(a, (t) => ws.teammate(t)?.name), at: a.created_at })
    supabase.from('activity').select('*').eq('run_id', id).order('created_at').then(({ data }) => setSteps(((data ?? []) as Activity[]).filter(isStep).map(say)))
    const live = liveChannel(() => supabase
      .channel(`garage-steps:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity', filter: `run_id=eq.${id}` }, (e) => {
        const a = e.new as Activity
        if (isStep(a)) setSteps((s) => (s.some((x) => x.id === a.id) ? s : [...s, say(a)]))
      }), () => {})
    return () => live.stop()
  }, [id, l, sample]) // eslint-disable-line react-hooks/exhaustive-deps
  const tm = ws.teammate(x?.run.teammate_id)
  const where = !x ? '' : x.run.thread_id.startsWith('dm:') ? 'Direct chat' : ws.threadTitle(x.run.thread_id)
  return (
    <Sheet open={!!l} onClose={onClose} accessibilityLabel="Working now">
      {x && (
        <View style={{ paddingHorizontal: 20, gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 4 }}>
            {tm && <TeammateAvatar teammate={tm} size={40} interactive={false} />}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="headline" numberOfLines={1}>{tm?.name ?? 'A teammate'}</Text>
              <Text variant="caption" color="ink3" numberOfLines={1}>Working in {where} · started {ago(x.run.started_at).toLowerCase()}{/^\d/.test(ago(x.run.started_at)) ? ' ago' : ''}</Text>
            </View>
          </View>
          <ScrollView style={{ maxHeight: 400 }}>
            {steps.length === 0 ? <ShimmerText text="Getting started…" size={15} /> : steps.map((s, i) => {
              const now = i === steps.length - 1
              return (
                <View key={s.id} style={{ flexDirection: 'row', gap: 12, paddingVertical: 7 }}>
                  <Text variant="footnote" color="ink3" tabular style={{ width: 62, marginTop: 3 }}>{clock(new Date(s.at))}</Text>
                  <View style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    {now ? <ShimmerText text={cap(s.text)} size={15} /> : <Text variant="body" color="ink2">{cap(s.text)}</Text>}
                  </View>
                </View>
              )
            })}
          </ScrollView>
          <Button label="Open in chat" size="lg" fullWidth onPress={() => { onClose(); openChat(x.run.thread_id) }} />
        </View>
      )}
    </Sheet>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const SAMPLE_STEPS = ['looked for the right app tool', 'listed open pull requests on GitHub', 'read pull request #142 on GitHub', 'read the CI logs for PR #142']

interface Upcoming {
  key: string; at: string; day: string; time: string; title: string; sub: string; teammate?: string
  auto?: Automation; follow?: Followup; reminder?: Reminder; event?: PhoneEvent
}

/** The next automation runs, follow-ups, reminders and calendar events, soonest first. */
function comingUp(automations: Automation[] | null, followups: Followup[] | null, reminders: Reminder[], events: PhoneEvent[]): Upcoming[] {
  const out: Upcoming[] = []
  const at = (iso: string) => { const [day, time] = whenLabel(iso).split(', '); return { day, time } }
  const now = new Date()
  for (const a of automations ?? []) {
    if (a.enabled && a.next_run) out.push({ key: a.id, at: a.next_run, ...at(a.next_run), title: a.name, sub: 'Automation', teammate: a.teammate_id, auto: a })
  }
  for (const f of followups ?? []) {
    const when = f.at ?? f.check_by
    if (!when) continue
    out.push({ key: f.id, at: when, ...at(when), title: f.what, sub: 'Follow-up', teammate: f.owner === 'group' ? undefined : f.owner, follow: f })
  }
  for (const r of reminders) {
    if (r.done) continue
    const next = reminderNext(r, now)
    if (next < now) continue
    const iso = next.toISOString()
    out.push({ key: r.id, at: iso, ...at(iso), title: r.title, sub: 'Reminder', reminder: r })
  }
  for (const e of events) {
    if (e.allDay || e.start < now.getTime()) continue
    const iso = new Date(e.start).toISOString()
    out.push({ key: `ev:${e.id}:${e.start}`, at: iso, ...at(iso), title: e.title || 'Event', sub: e.place ? `Calendar · ${e.place}` : 'Calendar', event: e })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 6)
}

/** A short timeline: the time on the left, what and who on the right; each opens its summary sheet. Under it, the
 * way into every follow-up. */
const ComingUp = memo(function ComingUp({ items, loading, onOpen, onFollowups }: {
  items: Upcoming[]; loading: boolean; onOpen: (u: Upcoming) => void; onFollowups: () => void
}) {
  const ws = useWorkspace()
  const { c } = useTheme()
  if (loading) return <View style={{ paddingHorizontal: 20, gap: 14 }}><Skeleton width="65%" /><Skeleton width="45%" /></View>
  return (
    <Surface style={{ marginHorizontal: 16, overflow: 'hidden' }}>
      {!items.length && <Text variant="body" color="ink3" style={{ padding: 16 }}>Nothing scheduled. Automations, follow-ups, reminders and events show up here before they happen.</Text>}
      {items.map((u, i) => {
        const tm = ws.teammate(u.teammate)
        const glyph = u.reminder ? BellRingIcon : u.event ? Calendar03Icon : null
        return (
          <View key={u.key}>
            {i > 0 && <Hairline />}
            <Press static onPress={() => onOpen(u)} accessibilityLabel={`${u.title}, ${u.day} ${u.time}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 }}>
              <View style={{ width: 74 }}>
                <Text variant="bodyMedium" tabular numberOfLines={1}>{u.time}</Text>
                <Text variant="footnote" color="ink3" numberOfLines={1}>{u.day}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyMedium" numberOfLines={1}>{u.title}</Text>
                <Text variant="caption" color="ink3" numberOfLines={1}>{[tm?.name, u.sub, u.follow && ws.threadTitle(u.follow.thread_id)].filter(Boolean).join(' · ')}</Text>
              </View>
              {tm ? <TeammateAvatar teammate={tm} size={28} interactive={false} paused />
                : glyph ? <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: u.event?.color || c.panel2, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon icon={glyph} size={15} color={u.event?.color ? '#fff' : 'ink2'} /></View> : null}
            </Press>
          </View>
        )
      })}
      <Hairline />
      <Press static onPress={onFollowups} accessibilityLabel="View all follow-ups"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 48 }}>
        <Text variant="label" color="ink2" style={{ flex: 1 }}>View all follow-ups</Text>
        <Icon icon={ArrowRight01Icon} size={16} color="ink3" />
      </Press>
    </Surface>
  )
})

/** Today's calendar, as the Calendar tab shows it. */
function EventsSheet({ open, events, onClose }: { open: boolean; events: PhoneEvent[]; onClose: () => void }) {
  const { c } = useTheme()
  return (
    <Sheet open={open} onClose={onClose} title={`Today’s calendar · ${events.length}`}>
      <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingBottom: 8 }}>
        {events.map((e, i) => (
          <View key={`${e.id}:${e.start}`}>
            {i > 0 && <Hairline />}
            <Press static onPress={() => { onClose(); router.push({ pathname: '/event/[id]', params: { id: e.id, start: String(e.start) } }) }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 }}>
              <View style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, backgroundColor: e.color || c.tube }} />
              <View style={{ width: 74 }}>
                <Text variant="bodyMedium" tabular>{e.allDay ? 'All day' : clock(new Date(e.start))}</Text>
                {!e.allDay && <Text variant="footnote" color="ink3" tabular>{clock(new Date(e.end))}</Text>}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyMedium" numberOfLines={2}>{e.title || 'Event'}</Text>
                {!!e.place && <Text variant="caption" color="ink3" numberOfLines={1}>{e.place}</Text>}
              </View>
            </Press>
          </View>
        ))}
      </ScrollView>
    </Sheet>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 6 }}>
      <Text variant="caption" color="ink3" style={{ width: 84 }}>{label}</Text>
      <Text variant="caption" color="ink" style={{ flex: 1 }}>{value}</Text>
    </View>
  )
}

/** What's coming, to look at: who, when, what it will do and how it went last time. One clear thing to do with it
 * (run it now, mark it done, open it where it lives); changing it happens where it lives, not here. */
function UpcomingSheet({ item, receipts, sample, onClose, onChanged }: {
  item: Upcoming | null; receipts: Receipt[]; sample: boolean; onClose: () => void; onChanged: () => void
}) {
  const ws = useWorkspace()
  const { c } = useTheme()
  const [last, setLast] = useState<Upcoming | null>(null)
  if (item && item !== last) setLast(item)
  const u = item ?? last
  const tm = ws.teammate(u?.teammate)
  const a = u?.auto
  const f = u?.follow
  const rem = u?.reminder
  const ev = u?.event
  const prev = a ? receipts.find((r) => r.automation_id === a.id) : undefined
  const health = a ? lastRun(a) : null
  const go = (to: () => void) => { onClose(); to() }
  const act = async (work: () => Promise<unknown>) => { if (!sample) { await work(); onChanged() } onClose() }
  const kind = a ? `Automation · ${tm?.name ?? 'a teammate'}` : f ? `Follow-up · ${tm?.name ?? 'the group'}` : rem ? 'Reminder' : 'Calendar'
  const when = !u ? '' : ev ? `${u.day}, ${clock(new Date(ev.start))} – ${clock(new Date(ev.end))}` : `${u.day}, ${u.time}`
  const glyph = rem ? BellRingIcon : Calendar03Icon
  return (
    <Sheet open={!!item} onClose={onClose} accessibilityLabel={u?.title}>
      {u && (
        <View style={{ paddingHorizontal: 20, gap: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 4 }}>
            {tm ? <TeammateAvatar teammate={tm} size={40} interactive={false} paused /> : (
              <Squircle style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: ev?.color || c.panel2, alignItems: 'center', justifyContent: 'center' }}>
                <Icon icon={glyph} size={20} color={ev?.color ? '#fff' : 'ink2'} />
              </Squircle>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="headline" numberOfLines={2}>{u.title}</Text>
              <Text variant="caption" color="ink3" numberOfLines={1}>{kind}</Text>
            </View>
          </View>
          <Squircle style={{ borderRadius: 16, backgroundColor: c.panel2, paddingHorizontal: 16, paddingVertical: 12, gap: 2 }}>
            <Text variant="footnote" color="ink3">{a ? 'Next run' : f ? 'Checks back' : rem ? 'Reminds you' : 'When'}</Text>
            <Text variant="headline" tabular>{when}</Text>
            {!!f?.until && <Text variant="caption" color="ink2">or as soon as {f.until}</Text>}
          </Squircle>
          <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: 14 }}>
            <View>
              {a && <Line label="Repeats" value={whenText(a)} />}
              {a && a.upcoming.length > 1 && <Line label="After that" value={a.upcoming.slice(1).map((x) => whenLabel(x)).join(' · ')} />}
              {health && <Line label="Last time" value={health.text} />}
              {f && <Line label="In" value={ws.threadTitle(f.thread_id)} />}
              {rem && <Line label="Repeats" value={REPEATS.find((x) => x.value === rem.repeat)?.label ?? 'Once'} />}
              {!!rem?.notes && <Line label="Notes" value={rem.notes} />}
              {!!ev?.place && <Line label="Where" value={ev.place} />}
              {!!ev?.notes && <Line label="Notes" value={ev.notes} />}
            </View>
            {a?.instructions ? (
              <View style={{ gap: 4 }}>
                <Text variant="overline" color="ink3">What it does</Text>
                <Text variant="body" color="ink2">{a.instructions}</Text>
              </View>
            ) : null}
            {prev?.headline && (
              <View style={{ gap: 4 }}>
                <Text variant="overline" color="ink3">Today it found</Text>
                <Text variant="body" color="ink2">{prev.headline}</Text>
              </View>
            )}
          </ScrollView>
          <View style={{ gap: 4 }}>
            {a && <Button label="Run it now" size="lg" fullWidth onPress={() => act(() => runNow(a))} />}
            {a && <Button label="Open automation" variant="ghost" fullWidth onPress={() => go(() => openAutomation(a.id))} />}
            {f && <Button label="Open the chat" size="lg" fullWidth onPress={() => go(() => openChat(f.thread_id))} />}
            {f && <Button label="All follow-ups" variant="ghost" fullWidth onPress={() => go(() => router.push('/followups'))} />}
            {rem && <Button label="Mark done" size="lg" fullWidth onPress={() => act(async () => finishReminder(rem))} />}
            {ev && <Button label="Open in calendar" size="lg" fullWidth onPress={() => go(() => router.push({ pathname: '/event/[id]', params: { id: ev.id, start: String(ev.start) } }))} />}
          </View>
        </View>
      )}
    </Sheet>
  )
}

// --------------------------------------------------------------------------------------------------------- sample data

/** A believable day with the user's own teammates, to judge the layout without waiting for real runs. */
function sampleData(crew: Teammate[], mode: 'busy' | 'calm') {
  const pick = (i: number) => crew[i % Math.max(crew.length, 1)]?.id ?? null
  const [a, b, s, q, k] = [0, 1, 2, 3, 4].map(pick)
  const dm = (id: string | null) => `dm:${id}`
  const now = Date.now()
  const past = (min: number) => new Date(now - min * 60000).toISOString()
  const ahead = (h: number) => new Date(now + h * 3600000).toISOString()
  const today = isoDay(new Date())
  const yesterday = isoDay(new Date(now - 86400000))
  const R = (r: Omit<Receipt, 'headline'> & { headline?: string }): Receipt => ({ headline: null, ...r })
  const hiring = R({ run_id: 's0', thread_id: dm(a), teammate_id: a, trigger: 'schedule', automation_id: 'sa1', title: 'Inbox check', outcome: 'posted', steps: 6, apps: ['gmail'], duration_ms: 94000, at: past(12),
    headline: '31 applicants for Junior AI: Asha, Ravi and Meera stand out',
    text: '**31 applicants for Junior AI: Asha, Ravi and Meera stand out**\n\nHR sent 31 profiles. I read every email and resume and scored them on ML depth, shipped projects and how they write.\n\n1. **Asha Menon** (9/10): 3 years of PyTorch, shipped a RAG app used by 2k people, clear cover note.\n2. **Ravi Kumar** (8.5/10): Kaggle Expert, fine-tuned Llama for Hindi support tickets.\n3. **Meera Iyer** (8/10): strong maths, built an eval harness at her internship.\n\n6 more are worth a look; 22 don’t meet the basics (no ML work). Want me to schedule interviews with the top 3?' })
  const receipts: Receipt[] = mode === 'calm' ? [
    R({ run_id: 's1', thread_id: dm(a), teammate_id: a, trigger: 'schedule', automation_id: 'sa1', title: 'Inbox check', outcome: 'posted', steps: 4, apps: ['gmail'], duration_ms: 38000, at: past(55),
      headline: '1 email needs you: the landlord wants a signing date', text: '**1 email needs you: the landlord wants a signing date**\n\nThe other 9 were newsletters; I archived them.' }),
    R({ run_id: 's3', thread_id: dm(s), teammate_id: s, trigger: 'schedule', automation_id: 'sa2', title: 'Weekly post ideas', outcome: 'quiet', steps: 3, apps: ['web'], duration_ms: 21000, at: past(130), text: '' }),
    R({ run_id: 's4', thread_id: dm(k), teammate_id: k, trigger: 'schedule', automation_id: null, title: null, outcome: 'posted', steps: 2, apps: ['googlecalendar'], duration_ms: 12000, at: past(190),
      text: 'Ravi confirmed **Thursday, 4 pm**. I added it to your calendar and sent him the invite.' }),
  ] : [
    hiring,
    R({ run_id: 's2', thread_id: dm(b), teammate_id: b, trigger: 'message', automation_id: null, title: null, outcome: 'posted', steps: 9, apps: ['github', 'code'], duration_ms: 252000, at: past(70),
      text: 'Fixed the flaky upload test and pushed `fix/upload-retry`. CI is green and **PR #142** is ready for your review.' }),
    R({ run_id: 's3', thread_id: dm(s), teammate_id: s, trigger: 'schedule', automation_id: 'sa2', title: 'Weekly post ideas', outcome: 'quiet', steps: 3, apps: ['web'], duration_ms: 21000, at: past(130), text: '' }),
    R({ run_id: 's4', thread_id: dm(k), teammate_id: k, trigger: 'schedule', automation_id: null, title: null, outcome: 'posted', steps: 2, apps: ['googlecalendar'], duration_ms: 12000, at: past(190),
      text: 'Ravi confirmed **Thursday, 4 pm**. I added it to your calendar and sent him the invite.' }),
    R({ run_id: 's5', thread_id: dm(q), teammate_id: q, trigger: 'schedule', automation_id: 'sa3', title: 'Nightly smoke test', outcome: 'failed', steps: 2, apps: ['code'], duration_ms: 31000, at: past(320),
      text: 'The staging server didn’t answer within 30 s.' }),
    R({ run_id: 's6', thread_id: dm(a), teammate_id: a, trigger: 'schedule', automation_id: 'sa1', title: 'Inbox check', outcome: 'posted', steps: 3, apps: ['gmail'], duration_ms: 29000, at: past(460),
      headline: 'Only one email needs you: the landlord', text: 'Only one email needs you: **the landlord** asked when you can sign the renewal.' }),
  ]
  const run = (id: string, teammate: string | null, thread: string): Run => (
    { id, owner_id: '', thread_id: thread, teammate_id: teammate, trigger: 'message', status: 'running', error: null, handoffs: 0, started_at: past(1) } as Run)
  const live: Live[] = mode === 'calm' ? [] : [
    { run: run('l1', b, dm(b)), doing: 'read pull request #142 on GitHub' },
    { run: run('l2', s, dm(s)), doing: 'searched the web for GATE 2027 dates' },
  ]
  const approvals: Approval[] = mode === 'calm' ? [] : [{
    id: 'sample-approval', kind: 'approval', answer: null, owner_id: '', thread_id: dm(a), teammate_id: a, run_id: null, message_id: null,
    tool_name: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', title: 'Send the reply to Priya',
    draft: { recipient_email: 'priya@acme.example', subject: 'Re: Revised quote', body: 'Hi Priya, thanks for the patience. The revised quote is attached; it covers the extra seats. Happy to talk it through on Thursday.' },
    final_args: null, note: null, status: 'pending', decided_at: null, created_at: past(12),
  }]
  const auto = (id: string, name: string, teammate: string | null, when: string, recent: Automation['recent'], extra: Partial<Automation> = {}): Automation => ({
    id, name, instructions: '', kind: 'schedule', when, enabled: true, teammate_id: teammate ?? '', thread_id: dm(teammate), created_at: past(9000),
    cron: null, tz: null, trigger: null, app: null, settings: {}, keywords: [], toolkits: null, upcoming: [], problems: [],
    last_run: past(12), next_run: null, recent, ...extra,
  })
  const automations: Automation[] = [
    auto('sa1', 'Inbox check', a, 'every 2 hours', ['posted', 'posted', 'quiet', 'posted', 'posted'], {
      next_run: ahead(1.8), upcoming: [ahead(1.8), ahead(3.8), ahead(5.8)],
      instructions: 'Check my inbox. Tell me only what needs my attention. When people send applications, read the resumes, score each candidate and rank them.',
    }),
    auto('sa4', 'New issue triage', b, 'when a GitHub issue is opened', ['posted', 'posted'], { kind: 'app', trigger: 'GITHUB_ISSUE_ADDED_EVENT', app: 'github', last_run: past(300) }),
    auto('sa2', 'Weekly post ideas', s, 'every Monday at 10 AM', ['quiet', 'posted', 'posted'], { next_run: ahead(70), upcoming: [ahead(70), ahead(238)], last_run: past(130), instructions: 'Find 3 post ideas from this week’s AI news.' }),
    auto('sa3', 'Nightly smoke test', q, 'every night at 2 AM', mode === 'calm' ? ['posted', 'posted'] : ['failed', 'failed', 'posted'], { next_run: ahead(9), upcoming: [ahead(9)], last_run: past(320), instructions: 'Open staging, sign in with the test account and check the upload flow.' }),
  ]
  const F = (id: string, owner: string | null, what: string, extra: Partial<Followup> = {}): Followup => (
    { id, thread_id: dm(owner), what, owner: owner ?? '', at: null, until: null, check_by: null, poll_hours: null, set_by: '', created: past(600), ...extra })
  const followups: Followup[] = [
    F('sf1', k, 'Check if Ravi sent the deck', { at: ahead(0.6) }),
    F('sf2', a, 'Ask Priya if the revised quote works', { at: ahead(20) }),
    F('sf3', b, 'Review PR #142 once CI is green', { until: 'CI on PR #142 passes', poll_hours: 2 }),
    F('sf4', s, 'Post the launch thread when the blog is live', { until: 'the blog post is published' }),
  ]
  const done: Followup[] = [
    F('sd1', a, 'Remind Akhil to sign the lease renewal', { status: 'done', closed: past(240) }),
    F('sd2', k, 'Confirm Thursday’s call with Ravi', { status: 'fired', closed: past(190) }),
    F('sd3', q, 'Re-run the smoke test after the deploy', { status: 'cancelled', closed: past(900) }),
  ]
  const Rm = (id: string, title: string, at: string, repeat: Reminder['repeat'] = ''): Reminder => (
    { id, title, notes: '', at, repeat, done: false, done_at: null, created_at: past(3000), updated_at: past(3000) })
  const reminders: Reminder[] = mode === 'calm' ? [Rm('r1', 'Drink water', ahead(0.4), 'daily')]
    : [Rm('r1', 'Call Amma', ahead(0.3)), Rm('r2', 'GATE mock test', ahead(14), 'weekly')]
  const todo = (id: string, title: string, due: string): Todo => ({ id, title, due, status: 'todo', notes: '', priority: 0, project_id: null, thread_id: null, added_by: null, assignee: null, labels: [], sort: 0, created_at: past(2000), updated_at: past(2000), completed_at: null } as Todo)
  const todos: Todo[] = mode === 'calm' ? [todo('t1', 'Revise Signals & Systems notes', today)]
    : [todo('t1', 'Fill the GATE correction form', today), todo('t2', 'Pay the electricity bill', yesterday), todo('t3', 'Revise Signals & Systems notes', today)]
  const E = (id: string, title: string, startH: number, mins: number, color: string, place = ''): PhoneEvent => {
    const start = Date.now() + startH * 3600000
    return { id, title, start, end: start + mins * 60000, allDay: false, place, notes: '', color, calendar: 'sample', rrule: '' }
  }
  const events: PhoneEvent[] = mode === 'calm' ? [E('e1', 'Study block: Networks', 1.2, 90, '#7c5cff')]
    : [E('e1', 'Sync with Ravi', 0.8, 30, '#0b8043', 'Google Meet'), E('e2', 'Study block: Networks', 2.5, 90, '#7c5cff'), E('e3', 'Gym', 4, 60, '#f4511e')]
  return { receipts, live, approvals, automations, followups, done, todos, reminders, events }
}
