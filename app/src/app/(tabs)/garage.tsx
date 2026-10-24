// Garage: the crew's home base. A blue summary card says how the day went (who did what, what needs you, who is
// working, what's next) with the day's highlights under it (what automations found, to-dos due); every number in it
// opens the runs behind it. Then: what needs you, today's runs as receipts, who is working now, what's coming up
// (each opens a summary sheet) and the automations behind it. Every step of every run is in All activity (/activity).
// `?demo=busy` or `?demo=calm` fills it with sample data to judge the layout.
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { setStatusBarStyle } from 'expo-status-bar'
import { LinearGradient } from 'expo-linear-gradient'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Text as RNText, RefreshControl, ScrollView, View } from 'react-native'
import Animated, { interpolate, runOnJS, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Add01Icon, AlertCircleIcon, ArrowDown01Icon, ArrowRight01Icon, BrowserIcon, Calendar03Icon, CheckmarkSquare02Icon,
  CodeIcon, Globe02Icon, LaptopIcon, RepeatIcon, Tick02Icon, WorkHistoryIcon,
} from '@hugeicons/core-free-icons'

import { ApprovalCard } from '@/components/approval-card'
import { AutomationGlyph, AutomationRows, lastRun } from '@/components/automation-rows'
import { BrandTile } from '@/components/brand-mark'
import { useTabBarInset } from '@/components/tab-bar'
import { describe, isShown } from '@/lib/activity'
import { api } from '@/lib/api'
import { openAutomation, runNow, setEnabled, useAutomations, whenText, type Automation } from '@/lib/automations'
import { ago, whenLabel } from '@/lib/format'
import { liveChannel } from '@/lib/realtime'
import { supabase } from '@/lib/supabase'
import { cancelFollowup, dueLabel, followupNow, isoDay, useFollowups, useTodos, type Followup, type Todo } from '@/lib/tasks'
import type { Activity, Approval, Run, Teammate } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { fonts, radius, useTheme } from '@/theme'
import { ShimmerText } from '@/ui/shimmer-text'
import {
  AvatarGroup, Button, Collapse, Icon, ListRow, Markdown, Press, Sheet, Skeleton, Surface, TeammateAvatar, Text,
  confirm, useFlip,
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
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: onBlue ? '#fff' : c.panel2, borderWidth: 1, borderColor: onBlue ? 'transparent' : c.line, alignItems: 'center', justifyContent: 'center' }}>
      <Icon icon={p.icon} size={Math.round(size * 0.58)} color={onBlue ? BLUE[1] : 'ink2'} />
    </View>
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
  const [receipts, setReceipts] = useState<Receipt[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const [focused, setFocused] = useState(true)
  const [jobs, setJobs] = useState<Jobs | null>(null)
  const [one, setOne] = useState<Receipt | null>(null)
  const [later, setLater] = useState<Upcoming | null>(null)

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

  const loadReceipts = useCallback(() => api<Receipt[]>(`/garage/runs?since=${encodeURIComponent(midnight())}`)
    .then((rs) => setReceipts(rs.map((r) => ({ ...r, apps: r.apps ?? [], text: r.text ?? '', headline: r.headline ?? null }))),
      () => setReceipts((r) => r ?? [])), [])
  useFocusEffect(useCallback(() => {
    loadReceipts()
    setFocused(true)
    setStatusBarStyle(past.get() && scheme !== 'dark' ? 'dark' : 'light')
    return () => { setFocused(false); setStatusBarStyle(scheme === 'dark' ? 'light' : 'dark') }
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
  const running = ws.liveRuns.filter((r) => r.status === 'running')
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
  const d = sample ?? {
    receipts, automations: autos.list, followups: follow.pending, approvals: ws.pendingApprovals,
    live: running.map((run) => ({ run, doing: doing[run.id] })), todos: todos ?? [],
  }

  // Automations that can't work or stopped on their own need you as much as an approval does.
  const broken = (d.automations ?? []).filter((a) => a.problems.length
    || (!a.enabled && (a.recent ?? []).length >= 3 && a.recent!.slice(0, 3).every((o) => o === 'failed')))
  const upcoming = useMemo(() => comingUp(d.automations, d.followups, ws.threadTitle), [d.automations, d.followups, ws.threadTitle])
  const due = (d.todos as Todo[]).filter((t) => t.due && t.status !== 'done' && t.status !== 'canceled' && t.due <= isoDay(new Date()))
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
          onHeight={(h) => heroH.set(h)}
          name={name}
          receipts={d.receipts}
          needs={needs}
          live={d.live}
          next={upcoming[0]}
          due={due}
          mode={mode}
          onJobs={setJobs}
          onReceipt={setOne}
          onNeeds={() => scroller.current?.scrollTo({ y: needsY.current - insets.top - 8, animated: true })}
          onNext={setLater}
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
                        leading={<AutomationGlyph a={a} size={32} />}
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
          <Today receipts={d.receipts} />
        </Section>

        <Section title={d.live.length ? `Working now · ${d.live.length}` : 'Working now'}>
          <WorkingNow live={d.live} animate={focused} />
        </Section>

        <Section title="Coming up">
          <ComingUp items={upcoming} loading={d.automations === null || d.followups === null} onOpen={setLater} />
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
                  leading={<View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}><Icon icon={RepeatIcon} size={16} color="tube" /></View>}
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

      <JobsSheet which={jobs} receipts={d.receipts ?? []} onClose={() => setJobs(null)} />
      <Sheet open={!!one} onClose={() => setOne(null)} title={one?.title ?? 'Run'}>
        {one && <ReceiptRow r={one} startOpen />}
      </Sheet>
      <UpcomingSheet item={later} receipts={d.receipts ?? []} sample={!!sample} onClose={() => setLater(null)} onChanged={() => { autos.load(); follow.refresh() }} />
    </View>
  )
}

// ---------------------------------------------------------------------------------------------------------------- hero

/** A bright phrase in the hero; tappable ones open what they count. */
function B({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  return <RNText onPress={onPress} suppressHighlighting style={{ color: '#fff' }}>{children}</RNText>
}

/** The day in one sentence, its highlights, and the outcome counts; every number opens what's behind it. */
function Hero({ name, receipts, needs, live, next, due, mode, onHeight, onJobs, onReceipt, onNeeds, onNext }: {
  name: string | null; receipts: Receipt[] | null; needs: number; live: Live[]; next?: Upcoming; due: Todo[]
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
    <View onLayout={(e) => onHeight(e.nativeEvent.layout.height)} style={{ borderBottomLeftRadius: 32, borderBottomRightRadius: 32, overflow: 'hidden', marginBottom: 20 }}>
      <LinearGradient colors={BLUE} start={{ x: 0, y: 0 }} end={{ x: 0.4, y: 1 }} style={{ paddingTop: insets.top + 10, paddingHorizontal: 20, paddingBottom: 16 }}>
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
            {next ? <> Next up <Chip icon={Calendar03Icon} /> <B onPress={() => onNext(next)}>{next.title}</B> {next.day.toLowerCase() === 'today' ? 'at' : next.day.toLowerCase()} <B>{next.time}</B>.</> : null}
          </Text>
        )}

        {(found.length > 0 || due.length > 0) && (
          <View style={{ marginTop: 18, gap: 4 }}>
            {found.map((r) => (
              <Highlight key={r.run_id} onPress={() => onReceipt(r)}
                tile={r.apps[0] ? <PlaceTile place={r.apps[0]} size={26} onBlue /> : <WhiteTile icon={RepeatIcon} />}
                title={r.title ?? 'Automation'} body={r.headline!} />
            ))}
            {due.length > 0 && (
              <Highlight onPress={() => router.navigate('/tasks')} tile={<WhiteTile icon={CheckmarkSquare02Icon} />}
                title={overdue.length ? `${plural(due.length, 'to-do')} due, ${overdue.length} overdue` : `${plural(due.length, 'to-do')} due today`}
                body={due.slice(0, 3).map((t) => t.title).join(', ')} />
            )}
          </View>
        )}

        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 16, marginBottom: 10 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 }}>
          <Stat icon={Tick02Icon} n={counts.posted} label="posted" onPress={() => onJobs('posted')} />
          <Stat n={counts.quiet} label="quiet" onPress={() => onJobs('quiet')} />
          {counts.failed > 0 && <Stat icon={AlertCircleIcon} n={counts.failed} label="failed" onPress={() => onJobs('failed')} />}
          <View style={{ flex: 1 }} />
          {worked.length > 0 && places(worked, 20, BLUE[1])}
        </View>
      </LinearGradient>
    </View>
  )
}

function Highlight({ tile, title, body, onPress }: { tile: ReactNode; title: string; body: string; onPress: () => void }) {
  return (
    <Press radius={12} static onPress={onPress} accessibilityLabel={`${title}: ${body}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
      {tile}
      <RNText numberOfLines={2} style={{ flex: 1, fontFamily: fonts.regular, fontSize: 15, lineHeight: 20, color: DIM }}>
        <RNText style={{ fontFamily: fonts.semibold, color: '#fff' }}>{title}</RNText>  {body}
      </RNText>
    </Press>
  )
}

function WhiteTile({ icon }: { icon: typeof RepeatIcon }) {
  return (
    <View style={{ width: 26, height: 26, borderRadius: 8, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
      <Icon icon={icon} size={16} color={BLUE[1]} strokeWidth={2} />
    </View>
  )
}

function Faces({ people }: { people: Teammate[] }) {
  return (
    <View style={{ transform: [{ translateY: 6 }] }}>
      <AvatarGroup size={24} max={6} ring={BLUE_MID} items={people.map((t) => ({ key: t.id, name: t.name, render: (s) => <TeammateAvatar teammate={t} size={s} interactive={false} paused /> }))} />
    </View>
  )
}

function Chip({ icon }: { icon: typeof Calendar03Icon }) {
  return (
    <View style={{ transform: [{ translateY: 5 }], width: 28, height: 28, borderRadius: 8, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
      <Icon icon={icon} size={17} color={BLUE[1]} strokeWidth={2} />
    </View>
  )
}

function Dot() {
  return <View style={{ transform: [{ translateY: -3 }], width: 9, height: 9, borderRadius: 5, backgroundColor: '#ffb020' }} />
}

/** An outcome count; tap to see those runs. */
function Stat({ icon, n, label, onPress }: { icon?: typeof Tick02Icon; n: number; label: string; onPress: () => void }) {
  return (
    <Press radius={radius.pill} static onPress={onPress} disabled={!n} accessibilityLabel={`${n} ${label}. Show them`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, minHeight: 30, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.12)' }}>
      {icon && <Icon icon={icon} size={14} color="#fff" strokeWidth={2} />}
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

function Hairline({ inset }: { inset: number }) {
  const { c } = useTheme()
  return <View style={{ height: 1, marginLeft: inset, backgroundColor: c.line }} />
}

/** Today's finished runs, newest first, in one card. */
function Today({ receipts }: { receipts: Receipt[] | null }) {
  const [all, setAll] = useState(false)
  if (receipts === null) {
    return <View style={{ paddingHorizontal: 20, gap: 14 }}><Skeleton width="70%" /><Skeleton width="50%" /></View>
  }
  if (!receipts.length) {
    return <Text variant="body" color="ink3" style={{ paddingHorizontal: 20 }}>Nothing has finished yet today. Runs land here with what came of them.</Text>
  }
  const shown = all ? receipts : receipts.slice(0, SHOWN)
  return (
    <Surface style={{ marginHorizontal: 16, overflow: 'hidden' }}>
      <ReceiptList receipts={shown} />
      {receipts.length > shown.length && (
        <>
          <Hairline inset={0} />
          <Press static onPress={() => setAll(true)} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Text variant="label" color="ink2">Show {receipts.length - shown.length} more</Text>
          </Press>
        </>
      )}
    </Surface>
  )
}

function ReceiptList({ receipts }: { receipts: Receipt[] }) {
  return receipts.map((r, i) => (
    <View key={r.run_id}>
      {i > 0 && <Hairline inset={64} />}
      <ReceiptRow r={r} />
    </View>
  ))
}

/** The runs behind a number in the hero. */
function JobsSheet({ which, receipts, onClose }: { which: Jobs | null; receipts: Receipt[]; onClose: () => void }) {
  const [last, setLast] = useState<Jobs>('all')
  if (which && which !== last) setLast(which)
  const shown = last === 'all' ? receipts : receipts.filter((r) => r.outcome === last)
  const title = last === 'all' ? `${plural(shown.length, 'job')} today`
    : last === 'posted' ? `${shown.length} posted: they had something to tell you`
      : last === 'quiet' ? `${shown.length} quiet: checked, nothing new` : `${shown.length} failed`
  return (
    <Sheet open={!!which} onClose={onClose} title={title}>
      <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ paddingBottom: 4 }}>
        <ReceiptList receipts={shown} />
      </ScrollView>
    </Sheet>
  )
}

/** One run: what woke them, who, what came of it and where they worked. Opens into the full reply and what to do next. */
function ReceiptRow({ r, startOpen = false }: { r: Receipt; startOpen?: boolean }) {
  const ws = useWorkspace()
  const [open, setOpen] = useState(startOpen)
  const flip = useFlip(open)
  const tm = ws.teammate(r.teammate_id)
  const what = r.title ?? (r.trigger === 'schedule' ? 'Scheduled' : r.trigger === 'event' ? 'Event'
    : r.thread_id.startsWith('dm:') ? 'Asked by you' : ws.threadTitle(r.thread_id))
  const where = r.apps.map(placeName)
  const summary = r.outcome === 'quiet' ? (where.length ? `Checked ${list(where)}. Nothing new, so it stayed quiet.` : 'Nothing new, so it stayed quiet.')
    : r.outcome === 'cancelled' ? 'Stopped before it finished.'
      : r.outcome === 'failed' ? `Couldn’t finish${r.text ? `: ${plain(r.text)}` : '.'}`
        : plain(r.text)
  const meta = [r.steps ? plural(r.steps, 'step') : null, took(r.duration_ms)].filter(Boolean).join(' · ')

  return (
    <View>
      <Press
        static
        onPress={() => setOpen((o) => !o)}
        accessibilityLabel={`${what}, ${tm?.name ?? 'a teammate'}. ${summary}`}
        accessibilityHint={open ? 'Hides the reply' : 'Shows the whole reply'}
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 14, alignItems: 'flex-start' }}
      >
        {tm ? <TeammateAvatar teammate={tm} size={36} interactive={false} paused /> : <View style={{ width: 36 }} />}
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text variant="bodyMedium" numberOfLines={1} style={{ flexShrink: 1 }}>
              {what}<Text variant="body" color="ink3"> · {tm?.name ?? 'A teammate'}</Text>
            </Text>
            <View style={{ flex: 1 }} />
            <Text variant="footnote" color="ink3" tabular>{ago(r.at)}</Text>
            <Animated.View style={flip}><Icon icon={ArrowDown01Icon} size={14} color="ink3" /></Animated.View>
          </View>
          {!open && (
            <Text variant="body" color={r.outcome === 'failed' ? 'danger' : r.outcome === 'posted' ? 'ink2' : 'ink3'} numberOfLines={2}>{summary}</Text>
          )}
          {(r.apps.length > 0 || meta) && !open && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 2 }}>
              {r.apps.length > 0 && places(r.apps, 16, undefined)}
              {meta ? <Text variant="footnote" color="ink3" tabular>{meta}</Text> : null}
            </View>
          )}
        </View>
      </Press>
      <Collapse open={open}>
        <View style={{ paddingLeft: 62, paddingRight: 14, paddingBottom: 14, gap: 12 }}>
          {r.outcome === 'posted' ? <Markdown value={r.text} /> : (
            <Text variant="body" color={r.outcome === 'failed' ? 'danger' : 'ink2'}>{summary}</Text>
          )}
          {(where.length > 0 || meta) && (
            <Text variant="footnote" color="ink3">{[where.length ? `Worked in ${list(where)}` : null, meta].filter(Boolean).join(' · ')}</Text>
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button label="Open in chat" size="sm" variant="soft" onPress={() => openChat(r.thread_id)} />
            {r.automation_id && <Button label="Automation" size="sm" variant="ghost" onPress={() => openAutomation(r.automation_id!)} />}
            {r.automation_id && r.outcome === 'failed' && (
              <Button label="Try again" size="sm" variant="ghost" onPress={() => runNow({ id: r.automation_id!, name: r.title ?? 'it' } as Automation)} />
            )}
          </View>
        </View>
      </Collapse>
    </View>
  )
}

/** What each running run is doing this moment: its latest step, live. */
function useDoing(runs: Run[], teammate: (id: string | null | undefined) => Teammate | undefined) {
  const [doing, setDoing] = useState<Record<string, string>>({})
  const ids = runs.map((r) => r.id).join(',')
  const sentence = useCallback((a: Activity) => describe(a, (id) => teammate(id)?.name), [teammate])
  const useful = (a: Activity) => a.type !== 'run_start' && a.type !== 'run_end' && a.type !== 'event' && isShown(a)
  useEffect(() => {
    if (!ids) return
    supabase.from('activity').select('*').in('run_id', ids.split(',')).order('created_at', { ascending: false }).limit(30)
      .then(({ data }) => {
        const latest: Record<string, string> = {}
        for (const a of (data ?? []) as Activity[]) if (a.run_id && !latest[a.run_id] && useful(a)) latest[a.run_id] = sentence(a)
        setDoing(latest)
      })
    const live = liveChannel(() => supabase
      .channel(`garage-now:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity' }, (e) => {
        const a = e.new as Activity
        if (a.run_id && ids.includes(a.run_id) && useful(a)) setDoing((d) => ({ ...d, [a.run_id!]: sentence(a) }))
      }), () => {})
    return () => live.stop()
  }, [ids, sentence])
  return doing
}

/** Who is working: their face, where, and their latest step with a light sweeping through it while on screen. */
function WorkingNow({ live, animate }: { live: Live[]; animate: boolean }) {
  const ws = useWorkspace()
  if (!live.length) return <Text variant="body" color="ink3" style={{ paddingHorizontal: 20 }}>Everyone’s free. Runs show here, step by step, while they happen.</Text>
  return (
    <Surface style={{ marginHorizontal: 16, overflow: 'hidden' }}>
      {live.map(({ run, doing }, i) => {
        const tm = ws.teammate(run.teammate_id)
        const where = run.thread_id.startsWith('dm:') ? 'Direct chat' : ws.threadTitle(run.thread_id)
        const step = doing ? `Just ${doing}` : 'Getting started…'
        return (
          <View key={run.id}>
            {i > 0 && <Hairline inset={64} />}
            <Press static onPress={() => openChat(run.thread_id)} accessibilityLabel={`${tm?.name ?? 'A teammate'} is working in ${where}. ${step}`}
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
}

interface Upcoming { key: string; at: string; day: string; time: string; title: string; sub: string; teammate?: string; auto?: Automation; follow?: Followup }

/** The next automation runs and follow-ups, soonest first. */
function comingUp(automations: Automation[] | null, followups: Followup[] | null, threadTitle: (id: string) => string): Upcoming[] {
  const out: Upcoming[] = []
  const at = (iso: string) => { const [day, time] = whenLabel(iso).split(', '); return { day, time } }
  for (const a of automations ?? []) {
    if (a.enabled && a.next_run) out.push({ key: a.id, at: a.next_run, ...at(a.next_run), title: a.name, sub: 'Automation', teammate: a.teammate_id, auto: a })
  }
  for (const f of followups ?? []) {
    const when = f.at ?? f.check_by
    if (!when) continue
    out.push({
      key: f.id, at: when, ...at(when), title: f.what, sub: `Follow-up · ${threadTitle(f.thread_id)}`,
      teammate: f.owner === 'group' ? undefined : f.owner, follow: f,
    })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 5)
}

/** A short timeline: the time on the left, what and who on the right. Each opens its summary sheet. */
function ComingUp({ items, loading, onOpen }: { items: Upcoming[]; loading: boolean; onOpen: (u: Upcoming) => void }) {
  const ws = useWorkspace()
  if (loading) return <View style={{ paddingHorizontal: 20, gap: 14 }}><Skeleton width="65%" /><Skeleton width="45%" /></View>
  if (!items.length) return <Text variant="body" color="ink3" style={{ paddingHorizontal: 20 }}>Nothing scheduled. Automations and follow-ups show up here before they run.</Text>
  return (
    <Surface style={{ marginHorizontal: 16, overflow: 'hidden' }}>
      {items.map((u, i) => {
        const tm = ws.teammate(u.teammate)
        return (
          <View key={u.key}>
            {i > 0 && <Hairline inset={100} />}
            <Press static onPress={() => onOpen(u)} accessibilityLabel={`${u.title}, ${u.day} ${u.time}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 }}>
              <View style={{ width: 74 }}>
                <Text variant="bodyMedium" tabular numberOfLines={1}>{u.time}</Text>
                <Text variant="footnote" color="ink3" numberOfLines={1}>{u.day}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyMedium" numberOfLines={1}>{u.title}</Text>
                <Text variant="caption" color="ink3" numberOfLines={1}>{[tm?.name, u.sub].filter(Boolean).join(' · ')}</Text>
              </View>
              {tm && <TeammateAvatar teammate={tm} size={28} interactive={false} paused />}
            </Press>
          </View>
        )
      })}
    </Surface>
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

/** What's coming, summed up in place: when, who, what it will do, how it went last time; run, pause or cancel here. */
function UpcomingSheet({ item, receipts, sample, onClose, onChanged }: {
  item: Upcoming | null; receipts: Receipt[]; sample: boolean; onClose: () => void; onChanged: () => void
}) {
  const ws = useWorkspace()
  const [last, setLast] = useState<Upcoming | null>(null)
  if (item && item !== last) setLast(item)
  const u = item ?? last
  const tm = ws.teammate(u?.teammate)
  const a = u?.auto
  const f = u?.follow
  const prev = a ? receipts.find((r) => r.automation_id === a.id) : undefined
  const health = a ? lastRun(a) : null
  const act = async (work: () => Promise<unknown>) => { if (!sample) { await work(); onChanged() } onClose() }
  const day = u ? (u.day.toLowerCase() === 'today' ? 'today' : u.day.toLowerCase()) : ''
  return (
    <Sheet open={!!item} onClose={onClose} title={u?.title}>
      {u && (
        <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {tm && <TeammateAvatar teammate={tm} size={32} interactive={false} paused />}
            <Text variant="body" color="ink2" style={{ flex: 1 }}>
              {tm ? `${tm.name} ` : ''}{a ? `runs it ${day} at ${u.time}` : `checks back ${day} at ${u.time}`}
            </Text>
          </View>
          <View>
            {a && <Line label="Repeats" value={whenText(a)} />}
            {a && a.upcoming.length > 1 && <Line label="After that" value={a.upcoming.slice(1).map((x) => whenLabel(x)).join(' · ')} />}
            {f && <Line label="In" value={ws.threadTitle(f.thread_id)} />}
            {health && <Line label="Last time" value={health.text} />}
          </View>
          {a?.instructions ? (
            <View style={{ gap: 4 }}>
              <Text variant="overline" color="ink3">What it does</Text>
              <Text variant="body" color="ink2" numberOfLines={6}>{a.instructions}</Text>
            </View>
          ) : null}
          {prev?.headline && (
            <View style={{ gap: 4 }}>
              <Text variant="overline" color="ink3">Today it found</Text>
              <Text variant="body" color="ink2">{prev.headline}</Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 }}>
            {a && <Button label="Run now" size="sm" variant="soft" onPress={() => act(() => runNow(a))} />}
            {a && <Button label="Pause" size="sm" variant="ghost" onPress={() => act(() => setEnabled(a, false))} />}
            {a && <Button label="Edit" size="sm" variant="ghost" onPress={() => { onClose(); openAutomation(a.id) }} />}
            {f && <Button label="Do it now" size="sm" variant="soft" onPress={() => act(() => followupNow(f.id))} />}
            {f && <Button label="Cancel it" size="sm" variant="ghost" onPress={() => act(async () => {
              if (await confirm({ title: 'Cancel this follow-up?', body: f.what, confirmLabel: 'Cancel it', cancelLabel: 'Keep it', destructive: true })) await cancelFollowup(f.id)
            })} />}
            {f && <Button label="Open chat" size="sm" variant="ghost" onPress={() => { onClose(); openChat(f.thread_id) }} />}
          </View>
        </ScrollView>
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
    text: '**31 applicants for Junior AI: Asha, Ravi and Meera stand out**\n\nThe HR team at mxcignite sent 31 profiles. I read every email and resume and scored them on ML depth, shipped projects and how they write.\n\n1. **Asha Menon** (9/10): 3 years of PyTorch, shipped a RAG app used by 2k people, clear cover note.\n2. **Ravi Kumar** (8.5/10): Kaggle Expert, fine-tuned Llama for Hindi support tickets.\n3. **Meera Iyer** (8/10): strong maths, built an eval harness at her internship.\n\n6 more are worth a look; 22 don’t meet the basics (no ML work). Want me to schedule interviews with the top 3?' })
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
  const followups: Followup[] = [
    { id: 'sf1', thread_id: dm(k), what: 'Check if Ravi sent the deck', owner: k ?? '', at: ahead(0.6), until: null, check_by: null, poll_hours: null, set_by: '', created: past(200) },
  ]
  const todo = (id: string, title: string, due: string): Todo => ({ id, title, due, status: 'todo', notes: '', priority: 0, project_id: null, thread_id: null, added_by: null, assignee: null, labels: [], sort: 0, created_at: past(2000), updated_at: past(2000), completed_at: null } as Todo)
  const todos: Todo[] = mode === 'calm' ? [todo('t1', 'Revise Signals & Systems notes', today)]
    : [todo('t1', 'Fill the GATE correction form', today), todo('t2', 'Pay the electricity bill', yesterday), todo('t3', 'Revise Signals & Systems notes', today)]
  return { receipts, live, approvals, automations, followups, todos }
}
