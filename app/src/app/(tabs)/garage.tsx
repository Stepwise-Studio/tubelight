// Garage: the crew's home base. A blue summary card says how the day went in one sentence (who did what, what needs
// you, who is working, what's next), then: what needs you, today's runs as receipts (what came of each one, where it
// worked), the now line (lit like a tube while anyone works), what's coming up and the automations behind it.
// Every step of every run is in All activity (/activity). `?demo=1` fills it with sample data to see the layout.
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { setStatusBarStyle } from 'expo-status-bar'
import { LinearGradient } from 'expo-linear-gradient'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Text as RNText, RefreshControl, View } from 'react-native'
import Animated, { interpolate, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Add01Icon, AlertCircleIcon, ArrowDown01Icon, ArrowRight01Icon, BrowserIcon, Calendar03Icon, CodeIcon, Globe02Icon,
  LaptopIcon, RepeatIcon, Tick02Icon, WorkHistoryIcon,
} from '@hugeicons/core-free-icons'

import { ApprovalCard } from '@/components/approval-card'
import { AutomationGlyph, AutomationRows } from '@/components/automation-rows'
import { BrandTile } from '@/components/brand-mark'
import { useTabBarInset } from '@/components/tab-bar'
import { describe, isShown } from '@/lib/activity'
import { api } from '@/lib/api'
import { openAutomation, runNow, useAutomations, type Automation } from '@/lib/automations'
import { ago, whenLabel } from '@/lib/format'
import { liveChannel } from '@/lib/realtime'
import { supabase } from '@/lib/supabase'
import { useFollowups, type Followup } from '@/lib/tasks'
import type { Activity, Approval, Run, Teammate } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { fonts, radius, useTheme } from '@/theme'
import {
  AvatarGroup, Button, Collapse, Icon, ListRow, Markdown, Press, Skeleton, Surface, TeammateAvatar, Text, useFlip,
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
  /** What it said (or why it failed). */
  text: string
}

interface Live { run: Run; doing?: string }

const BLUE = ['#3f7cff', '#1f50e3'] as const
const BLUE_MID = '#2f66f1' // behind inline faces, so their rings melt into the card
const DIM = 'rgba(255,255,255,0.58)'
const SHOWN = 4 // receipts before "Show more"

const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() }
const newAutomation = () => router.push({ pathname: '/automation/[id]', params: { id: 'new' } })
const openChat = (threadId: string) => router.push({ pathname: '/chat/[threadId]', params: { threadId } })
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Markdown to one plain line for previews. */
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

const places = (list: string[], size: number, ring?: string) => (
  <AvatarGroup size={size} max={ring ? 6 : 4} ring={ring} items={list.map((p) => ({ key: p, name: placeName(p), render: (s) => <PlaceTile place={p} size={s} onBlue={!!ring} /> }))} />
)

export default function GarageTab() {
  const { c, scheme } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const { demo } = useLocalSearchParams<{ demo?: string }>()
  const autos = useAutomations()
  const follow = useFollowups()
  const [receipts, setReceipts] = useState<Receipt[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [name, setName] = useState<string | null>(null)

  // Past the blue card the page shows under the clock: a canvas-coloured strip fades in there and the status bar
  // icons go back to the theme's.
  const insets = useSafeAreaInsets()
  const y = useSharedValue(0)
  const heroH = useSharedValue(400)
  const past = useSharedValue(false)
  const barFor = useCallback((over: boolean) => setStatusBarStyle(over && scheme !== 'dark' ? 'dark' : 'light'), [scheme])
  const onScroll = useAnimatedScrollHandler((e) => {
    y.set(e.contentOffset.y)
    const over = e.contentOffset.y > heroH.get() - insets.top
    if (over !== past.get()) { past.set(over); runOnJS(barFor)(over) }
  })
  const scrim = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [heroH.value - insets.top - 24, heroH.value - insets.top], [0, 1], 'clamp') }))

  const loadReceipts = useCallback(() => api<Receipt[]>(`/garage/runs?since=${encodeURIComponent(midnight())}`)
    .then((rs) => setReceipts(rs.map((r) => ({ ...r, apps: r.apps ?? [], text: r.text ?? '' }))), () => setReceipts((r) => r ?? [])), [])
  // The card is blue edge to edge: light status bar icons while you're here.
  useFocusEffect(useCallback(() => {
    loadReceipts()
    setStatusBarStyle(past.get() && scheme !== 'dark' ? 'dark' : 'light')
    return () => setStatusBarStyle(scheme === 'dark' ? 'light' : 'dark')
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

  const sample = useMemo(() => (demo ? sampleData(ws.teammates) : null), [demo, ws.teammates])
  const d = sample ?? {
    receipts, automations: autos.list, followups: follow.pending, approvals: ws.pendingApprovals,
    live: running.map((run) => ({ run, doing: doing[run.id] })),
  }

  // Automations that can't work or stopped on their own need you as much as an approval does.
  const broken = (d.automations ?? []).filter((a) => a.problems.length
    || (!a.enabled && (a.recent ?? []).length >= 3 && a.recent!.slice(0, 3).every((o) => o === 'failed')))
  const upcoming = useMemo(() => comingUp(d.automations, d.followups, ws.threadTitle), [d.automations, d.followups, ws.threadTitle])

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
    <Animated.ScrollView
      onScroll={onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={{ paddingBottom: inset + 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
    >
      <Hero
        onHeight={(h) => heroH.set(h)}
        name={name}
        receipts={d.receipts}
        needs={d.approvals.length + broken.length}
        live={d.live}
        next={upcoming[0]}
        demo={!!sample}
      />

      {d.approvals.length + broken.length > 0 && (
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
      )}

      <Section title="Today">
        <Today receipts={d.receipts} />
      </Section>

      <NowLine live={d.live} />

      <Section title="Coming up">
        <ComingUp items={upcoming} loading={d.automations === null || d.followups === null} />
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
    </View>
  )
}

// ---------------------------------------------------------------------------------------------------------------- hero

/** The day in one sentence. Bright words carry the facts, dim words join them, faces and icons sit inline. */
function Hero({ name, receipts, needs, live, next, demo, onHeight }: {
  onHeight: (h: number) => void; name: string | null; receipts: Receipt[] | null; needs: number; live: Live[]; next?: Upcoming; demo: boolean
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
  const busy = live.map((l) => ws.teammate(l.run.teammate_id)).filter((t): t is Teammate => !!t)


  return (
    <View onLayout={(e) => onHeight(e.nativeEvent.layout.height)} style={{ borderBottomLeftRadius: 32, borderBottomRightRadius: 32, overflow: 'hidden', marginBottom: 20 }}>
      <LinearGradient colors={BLUE} start={{ x: 0, y: 0 }} end={{ x: 0.4, y: 1 }} style={{ paddingTop: insets.top + 10, paddingHorizontal: 20, paddingBottom: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, marginBottom: 14 }}>
          <Text style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 17, color: '#fff' }} accessibilityRole="header">Garage</Text>
          {demo && (
            <Press radius={radius.pill} static onPress={() => router.setParams({ demo: undefined })} accessibilityLabel="Hide sample data"
              style={{ paddingHorizontal: 10, minHeight: 28, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.16)' }}>
              <Text variant="label" style={{ color: '#fff' }}>Sample data · Hide</Text>
            </Press>
          )}
        </View>

        {receipts === null ? (
          <View style={{ gap: 12, paddingVertical: 6 }}>
            {[0.9, 0.75, 0.55].map((w) => <View key={w} style={{ height: 22, width: `${w * 100}%`, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.14)' }} />)}
          </View>
        ) : (
          <Text style={{ fontFamily: fonts.semibold, fontSize: 23, lineHeight: 32, letterSpacing: -0.45, color: DIM }}>
            {hello}{name ? <>, <B>{name}</B></> : null}. {crew.length ? (
              <>Your crew <Faces people={crew} /> finished <B>{plural(done.length, 'job')}</B> today</>
            ) : <>Nothing has run yet today</>}
            {needs > 0 ? <>, and <Dot /> <B>{needs} {needs === 1 ? 'needs' : 'need'} you</B>.</> : '.'}
            {busy.length ? (
              <> <Faces people={busy.slice(0, 1)} /> <B>{busy[0].name}</B>{busy.length > 1 ? ` and ${busy.length - 1} more` : ''} {busy.length > 1 ? 'are' : 'is'} working right now.</>
            ) : null}
            {next ? <> Next up <Chip icon={Calendar03Icon} /> <B>{next.title}</B> {next.day.toLowerCase() === 'today' ? 'at' : next.day.toLowerCase()} <B>{next.time}</B>.</> : null}
          </Text>
        )}

        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 18, marginBottom: 12 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 28 }}>
          <Stat icon={Tick02Icon} n={counts.posted} label="posted" />
          <Text variant="label" style={{ color: DIM }}>{counts.quiet} quiet</Text>
          {counts.failed > 0 && <Stat icon={AlertCircleIcon} n={counts.failed} label="failed" />}
          <View style={{ flex: 1 }} />
          {worked.length > 0 && places(worked, 20, BLUE[1])}
        </View>
      </LinearGradient>
    </View>
  )
}

/** A bright phrase inside the hero sentence. */
function B({ children }: { children: ReactNode }) {
  return <RNText style={{ color: '#fff' }}>{children}</RNText>
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

function Stat({ icon, n, label }: { icon: typeof Tick02Icon; n: number; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} accessibilityLabel={`${n} ${label}`}>
      <Icon icon={icon} size={15} color={DIM} strokeWidth={2} />
      <Text variant="label" style={{ color: DIM }}>{n} {label}</Text>
    </View>
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
      {shown.map((r, i) => (
        <View key={r.run_id}>
          {i > 0 && <Hairline inset={64} />}
          <ReceiptRow r={r} />
        </View>
      ))}
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

function Hairline({ inset }: { inset: number }) {
  const { c } = useTheme()
  return <View style={{ height: 1, marginLeft: inset, backgroundColor: c.line }} />
}

/** One run: what woke them, who, what came of it and where they worked. Opens into the full reply and what to do next. */
function ReceiptRow({ r }: { r: Receipt }) {
  const ws = useWorkspace()
  const [open, setOpen] = useState(false)
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

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const took = (ms: number | null) => (ms === null ? null : ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`)

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

/** The now line: a thin tube that lights up while anyone works, with what each teammate is doing. */
function NowLine({ live }: { live: Live[] }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const lit = live.length > 0
  return (
    <View style={{ paddingBottom: 28 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, minHeight: 36, paddingBottom: 6 }}>
        <Text variant="headline" color={lit ? 'ink' : 'ink3'}>Now</Text>
        <View style={{
          flex: 1, height: lit ? 2 : 1, borderRadius: 1, backgroundColor: lit ? c.tube : c.line,
          ...(lit ? { shadowColor: c.tube, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 3 } : null),
        }} />
      </View>
      {lit ? (
        <Surface style={{ marginHorizontal: 16, overflow: 'hidden' }}>
          {live.map(({ run, doing }, i) => {
            const tm = ws.teammate(run.teammate_id)
            const where = run.thread_id.startsWith('dm:') ? null : ws.threadTitle(run.thread_id)
            return (
              <View key={run.id}>
                {i > 0 && <Hairline inset={64} />}
                <ListRow
                  leading={tm ? <TeammateAvatar teammate={tm} size={36} interactive={false} /> : undefined}
                  title={[tm?.name ?? 'A teammate', where].filter(Boolean).join(' · ')}
                  subtitle={doing ? `Just ${doing}` : 'Getting started…'}
                  chevron
                  onPress={() => openChat(run.thread_id)}
                />
              </View>
            )
          })}
        </Surface>
      ) : (
        <Text variant="body" color="ink3" style={{ paddingHorizontal: 20 }}>Nobody is working right now.</Text>
      )}
    </View>
  )
}

interface Upcoming { key: string; at: string; day: string; time: string; title: string; sub: string; teammate?: string; open: () => void }

/** The next automation runs and follow-ups, soonest first. */
function comingUp(automations: Automation[] | null, followups: Followup[] | null, threadTitle: (id: string) => string): Upcoming[] {
  const out: Upcoming[] = []
  const at = (iso: string) => { const [day, time] = whenLabel(iso).split(', '); return { day, time } }
  for (const a of automations ?? []) {
    if (a.enabled && a.next_run) out.push({ key: a.id, at: a.next_run, ...at(a.next_run), title: a.name, sub: 'Automation', teammate: a.teammate_id, open: () => openAutomation(a.id) })
  }
  for (const f of followups ?? []) {
    const when = f.at ?? f.check_by
    if (!when) continue
    out.push({
      key: f.id, at: when, ...at(when), title: f.what, sub: `Follow-up · ${threadTitle(f.thread_id)}`,
      teammate: f.owner === 'group' ? undefined : f.owner, open: () => openChat(f.thread_id),
    })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 5)
}

/** A short timeline: the time on the left, what and who on the right. */
function ComingUp({ items, loading }: { items: Upcoming[]; loading: boolean }) {
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
            <Press static onPress={u.open} accessibilityLabel={`${u.title}, ${u.day} ${u.time}`}
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

// --------------------------------------------------------------------------------------------------------- sample data

/** A believable day with the user's own teammates, to judge the layout without waiting for real runs. */
function sampleData(crew: Teammate[]) {
  const pick = (i: number) => crew[i % Math.max(crew.length, 1)]?.id ?? null
  const [a, b, s, q, k] = [0, 1, 2, 3, 4].map(pick)
  const dm = (id: string | null) => `dm:${id}`
  const now = Date.now()
  const past = (min: number) => new Date(now - min * 60000).toISOString()
  const ahead = (h: number) => new Date(now + h * 3600000).toISOString()
  const receipts: Receipt[] = [
    { run_id: 's1', thread_id: dm(a), teammate_id: a, trigger: 'schedule', automation_id: 'sa1', title: 'Inbox brief', outcome: 'posted', steps: 4, apps: ['gmail'], duration_ms: 38000, at: past(25),
      text: '**3 emails worth your time**\n\n- **Priya (Acme)** wants the revised quote by Friday. I drafted a reply for you to check.\n- **GitHub**: 2 pull requests are waiting on your review.\n- **Razorpay** payout of ₹48,200 landed.\n\nThe other 11 were newsletters, so I archived them.' },
    { run_id: 's2', thread_id: dm(b), teammate_id: b, trigger: 'message', automation_id: null, title: null, outcome: 'posted', steps: 9, apps: ['github', 'code'], duration_ms: 252000, at: past(70),
      text: 'Fixed the flaky upload test and pushed `fix/upload-retry`. CI is green and **PR #142** is ready for your review.' },
    { run_id: 's3', thread_id: dm(s), teammate_id: s, trigger: 'schedule', automation_id: 'sa2', title: 'Weekly post ideas', outcome: 'quiet', steps: 3, apps: ['web'], duration_ms: 21000, at: past(130), text: '' },
    { run_id: 's4', thread_id: dm(k), teammate_id: k, trigger: 'schedule', automation_id: null, title: null, outcome: 'posted', steps: 2, apps: ['googlecalendar'], duration_ms: 12000, at: past(190),
      text: 'Ravi confirmed **Thursday, 4 pm**. I added it to your calendar and sent him the invite.' },
    { run_id: 's5', thread_id: dm(q), teammate_id: q, trigger: 'schedule', automation_id: 'sa3', title: 'Nightly smoke test', outcome: 'failed', steps: 2, apps: ['code'], duration_ms: 31000, at: past(320),
      text: 'The staging server didn’t answer within 30 s.' },
    { run_id: 's6', thread_id: dm(a), teammate_id: a, trigger: 'schedule', automation_id: 'sa1', title: 'Inbox brief', outcome: 'posted', steps: 3, apps: ['gmail'], duration_ms: 29000, at: past(460),
      text: 'Only one email needs you: **the landlord** asked when you can sign the renewal.' },
  ]
  const run = (id: string, teammate: string | null, thread: string): Run => (
    { id, owner_id: '', thread_id: thread, teammate_id: teammate, trigger: 'message', status: 'running', error: null, handoffs: 0, started_at: past(1) } as Run)
  const live: Live[] = [
    { run: run('l1', b, dm(b)), doing: 'read pull request #142 on GitHub' },
    { run: run('l2', a, dm(a)), doing: 'drafted a Gmail reply' },
  ]
  const approvals: Approval[] = [{
    id: 'sample-approval', kind: 'approval', answer: null, owner_id: '', thread_id: dm(a), teammate_id: a, run_id: null, message_id: null,
    tool_name: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', title: 'Send the reply to Priya',
    draft: { recipient_email: 'priya@acme.example', subject: 'Re: Revised quote', body: 'Hi Priya, thanks for the patience. The revised quote is attached; it covers the extra seats. Happy to talk it through on Thursday.' },
    final_args: null, note: null, status: 'pending', decided_at: null, created_at: past(12),
  }]
  const auto = (id: string, name: string, teammate: string | null, when: string, recent: Automation['recent'], extra: Partial<Automation> = {}): Automation => ({
    id, name, instructions: '', kind: 'schedule', when, enabled: true, teammate_id: teammate ?? '', thread_id: dm(teammate), created_at: past(9000),
    cron: null, tz: null, trigger: null, app: null, settings: {}, keywords: [], toolkits: null, upcoming: [], problems: [],
    last_run: past(25), next_run: null, recent, ...extra,
  })
  const tomorrow8 = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.toISOString() })()
  const automations: Automation[] = [
    auto('sa1', 'Inbox brief', a, 'every day at 8 AM', ['posted', 'posted', 'quiet', 'posted', 'posted'], { next_run: tomorrow8 }),
    auto('sa4', 'New issue triage', b, 'when a GitHub issue is opened', ['posted', 'posted'], { kind: 'app', trigger: 'GITHUB_ISSUE_ADDED_EVENT', app: 'github', last_run: past(300) }),
    auto('sa2', 'Weekly post ideas', s, 'every Monday at 10 AM', ['quiet', 'posted', 'posted'], { next_run: ahead(70), last_run: past(130) }),
    auto('sa3', 'Nightly smoke test', q, 'every night at 2 AM', ['failed', 'failed', 'posted'], { next_run: ahead(9), last_run: past(320) }),
  ]
  const followups: Followup[] = [
    { id: 'sf1', thread_id: dm(k), what: 'Check if Ravi sent the deck', owner: k ?? '', at: ahead(2), until: null, check_by: null, poll_hours: null, set_by: '', created: past(200) },
  ]
  return { receipts, live, approvals, automations, followups }
}
