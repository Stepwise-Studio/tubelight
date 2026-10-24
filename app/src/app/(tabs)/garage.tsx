// Garage: the crew's home base. What needs you, what teammates finished today (one receipt per run), who is working
// right now (the "now" line, lit like a tube while anyone is), what comes up next and the automations behind it.
// Every step of every run is one level down, in All activity (/activity).
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { Add01Icon, ArrowDown01Icon, ArrowRight01Icon, RepeatIcon, WorkHistoryIcon } from '@hugeicons/core-free-icons'

import { ActivityRow } from '@/components/activity-row'
import { ApprovalCard } from '@/components/approval-card'
import { AutomationGlyph, AutomationRows } from '@/components/automation-rows'
import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { describe, isShown } from '@/lib/activity'
import { api } from '@/lib/api'
import { openAutomation, useAutomations, type Automation } from '@/lib/automations'
import { ago, whenLabel } from '@/lib/format'
import { liveChannel } from '@/lib/realtime'
import { supabase } from '@/lib/supabase'
import { useFollowups } from '@/lib/tasks'
import type { Activity, Approval, Run } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { radius, useTheme } from '@/theme'
import { Collapse, Icon, IconButton, ListRow, Press, Skeleton, Surface, TeammateAvatar, Text, useFlip } from '@/ui'

/** GET /garage/runs: a finished run in one line. */
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
  at: string
  preview: string
}

const SHOWN = 4 // receipts above the now line before "Show earlier"

const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() }
const newAutomation = () => router.push({ pathname: '/automation/[id]', params: { id: 'new' } })

export default function GarageTab() {
  const { c } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const autos = useAutomations()
  const follow = useFollowups()
  const [receipts, setReceipts] = useState<Receipt[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadReceipts = useCallback(() => api<Receipt[]>(`/garage/runs?since=${encodeURIComponent(midnight())}`)
    .then(setReceipts, () => setReceipts((r) => r ?? [])), [])
  useFocusEffect(useCallback(() => { loadReceipts() }, [loadReceipts]))

  // A run that just finished becomes a receipt (and may have changed an automation's dots).
  const working = ws.liveRuns.filter((r) => r.status === 'running')
  const count = useRef(working.length)
  useEffect(() => {
    if (working.length < count.current) { loadReceipts(); autos.load() }
    count.current = working.length
  }, [working.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    setRefreshing(true)
    await Promise.all([loadReceipts(), autos.load(), follow.refresh(), ws.refresh()])
    setRefreshing(false)
  }

  // Automations that stopped on their own or can't work: they need you as much as an approval does.
  const broken = (autos.list ?? []).filter((a) => a.problems.length || (!a.enabled && a.recent?.slice(0, 3).every((o) => o === 'failed') && a.recent.length >= 3))
  const needs = ws.pendingApprovals.length + broken.length

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: inset + 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
    >
      <TabHeader title="Garage" />

      {needs > 0 && (
        <Section title={`Needs you · ${needs}`}>
          <View style={{ gap: 16 }}>
            {ws.pendingApprovals.map((a) => <Waiting key={a.id} approval={a} />)}
            {broken.length > 0 && (
              <View style={{ paddingHorizontal: 16 }}>
                <Surface style={{ overflow: 'hidden' }}>
                  {broken.map((a) => (
                    <ListRow
                      key={a.id}
                      leading={<AutomationGlyph a={a} size={32} />}
                      title={a.name}
                      subtitle={a.problems[0] ?? 'Paused after 3 failed runs in a row'}
                      subtitleLines={2}
                      chevron
                      onPress={() => openAutomation(a.id)}
                    />
                  ))}
                </Surface>
              </View>
            )}
          </View>
        </Section>
      )}

      <Section title="Earlier today">
        <Earlier receipts={receipts} />
      </Section>

      <NowLine runs={working} />

      <Section title="Coming up">
        <ComingUp automations={autos.list} followups={follow.pending} />
      </Section>

      <Section
        title="Automations"
        right={<IconButton icon={Add01Icon} size={36} iconSize={18} accessibilityLabel="New automation" onPress={newAutomation} />}
      >
        <View style={{ paddingHorizontal: 16 }}>
          {autos.list === null ? (
            <Surface padding={16} style={{ gap: 10 }}><Skeleton width="60%" /><Skeleton width="40%" /></Surface>
          ) : autos.list.length === 0 ? (
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
            <AutomationRows items={autos.list} show="who" onToggle={autos.toggle} />
          )}
        </View>
      </Section>

      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <Surface>
          <ListRow title="All activity" subtitle="Every step teammates took" icon={WorkHistoryIcon} chevron onPress={() => router.push('/activity')} />
        </Surface>
      </View>
    </ScrollView>
  )
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={{ paddingBottom: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, minHeight: 36, paddingBottom: 4 }}>
        <Text variant="overline" color="ink3" accessibilityRole="header" style={{ flex: 1 }}>{title}</Text>
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
        onPress={() => router.push({ pathname: '/chat/[threadId]', params: { threadId: approval.thread_id } })}
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

/** Today's finished runs, oldest first so the newest sits just above the now line. */
function Earlier({ receipts }: { receipts: Receipt[] | null }) {
  const [all, setAll] = useState(false)
  if (receipts === null) {
    return <View style={{ paddingHorizontal: 20, gap: 14 }}><Skeleton width="70%" /><Skeleton width="50%" /></View>
  }
  if (!receipts.length) {
    return <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 20 }}>Nothing finished yet today.</Text>
  }
  const shown = all ? receipts : receipts.slice(0, SHOWN)
  const hidden = receipts.length - shown.length
  return (
    <View>
      {hidden > 0 && (
        <Press radius={8} static onPress={() => setAll(true)} outerStyle={{ alignSelf: 'flex-start', marginLeft: 14 }} style={{ paddingHorizontal: 6, minHeight: 32, justifyContent: 'center' }}>
          <Text variant="footnote" color="tube">Show {hidden} earlier</Text>
        </Press>
      )}
      {[...shown].reverse().map((r) => <ReceiptRow key={r.run_id} r={r} />)}
    </View>
  )
}

function ReceiptRow({ r }: { r: Receipt }) {
  const ws = useWorkspace()
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState<Activity[] | null>(null)
  const flip = useFlip(open)
  const tm = ws.teammate(r.teammate_id)
  const what = r.title ?? (r.trigger === 'schedule' ? 'Follow-up' : r.trigger === 'event' ? 'Event' : ws.threadTitle(r.thread_id))
  const line = r.outcome === 'quiet' ? 'Nothing new, stayed quiet'
    : r.outcome === 'cancelled' ? 'Stopped'
      : r.outcome === 'failed' ? `Failed${r.preview ? `: ${r.preview}` : ''}`
        : r.preview.replace(/\s+/g, ' ')
  const meta = [ago(r.at), r.steps ? `${r.steps} step${r.steps === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')

  const toggle = () => {
    setOpen((o) => !o)
    if (steps === null) {
      supabase.from('activity').select('*').eq('run_id', r.run_id).not('type', 'in', '(run_start,run_end)').order('created_at')
        .then(({ data }) => setSteps(((data ?? []) as Activity[]).filter(isShown)))
    }
  }

  return (
    <View>
      <Press
        radius={radius.md}
        static
        onPress={toggle}
        accessibilityLabel={`${tm?.name ?? 'A teammate'}, ${what}. ${line}. ${meta}`}
        accessibilityHint={open ? 'Hides the steps' : 'Shows the steps'}
        accessibilityState={{ expanded: open }}
        outerStyle={{ marginHorizontal: 4 }}
        style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'flex-start' }}
      >
        <View style={{ paddingTop: 1 }}>
          {tm ? <TeammateAvatar teammate={tm} size={32} interactive={false} paused /> : <View style={{ width: 32, height: 32 }} />}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {tm?.name ?? 'A teammate'}<Text variant="body" color="ink3"> · {what}</Text>
          </Text>
          <Text variant="body" color={r.outcome === 'failed' ? 'danger' : r.outcome === 'posted' ? 'ink2' : 'ink3'} numberOfLines={open ? 6 : 1}>{line}</Text>
          <Text variant="footnote" color="ink3" tabular>{meta}</Text>
        </View>
        <Animated.View style={[{ paddingTop: 3 }, flip]}><Icon icon={ArrowDown01Icon} size={16} color="ink3" /></Animated.View>
      </Press>
      <Collapse open={open}>
        <View style={{ paddingLeft: 40, paddingBottom: 8 }}>
          {steps === null ? null : steps.map((a) => <ActivityRow key={a.id} a={a} />)}
          <Press
            radius={8}
            static
            onPress={() => (r.automation_id ? openAutomation(r.automation_id) : router.push({ pathname: '/chat/[threadId]', params: { threadId: r.thread_id } }))}
            outerStyle={{ alignSelf: 'flex-start', marginLeft: 10 }}
            style={{ paddingHorizontal: 6, minHeight: 36, justifyContent: 'center' }}
          >
            <Text variant="footnote" color="tube">{r.automation_id ? 'Open automation' : 'Open chat'}</Text>
          </Press>
        </View>
      </Collapse>
    </View>
  )
}

/** The now line: a thin tube that lights up while anyone works, with what each teammate is doing this moment. */
function NowLine({ runs }: { runs: Run[] }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const [doing, setDoing] = useState<Record<string, string>>({})
  const ids = runs.map((r) => r.id).join(',')
  const lit = runs.length > 0
  const sentence = useCallback((a: Activity) => describe(a, (id) => ws.teammate(id)?.name), [ws])

  useEffect(() => {
    if (!ids) return
    supabase.from('activity').select('*').in('run_id', ids.split(',')).not('type', 'in', '(run_start,run_end)')
      .order('created_at', { ascending: false }).limit(30)
      .then(({ data }) => {
        const latest: Record<string, string> = {}
        for (const a of (data ?? []) as Activity[]) if (a.run_id && !latest[a.run_id] && isShown(a)) latest[a.run_id] = sentence(a)
        setDoing(latest)
      })
    const live = liveChannel(() => supabase
      .channel(`garage-now:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity' }, (e) => {
        const a = e.new as Activity
        if (a.run_id && ids.includes(a.run_id) && a.type !== 'run_start' && a.type !== 'run_end' && isShown(a)) {
          setDoing((d) => ({ ...d, [a.run_id!]: sentence(a) }))
        }
      }), () => {})
    return () => live.stop()
  }, [ids, sentence])

  return (
    <View style={{ paddingBottom: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, minHeight: 36 }}>
        <Text variant="overline" color={lit ? 'tube' : 'ink3'}>Now</Text>
        <View style={{
          flex: 1, height: lit ? 2 : 1, borderRadius: 1, backgroundColor: lit ? c.tube : c.line,
          ...(lit ? { shadowColor: c.tube, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 3 } : null),
        }} />
      </View>
      {lit ? runs.map((r) => {
        const tm = ws.teammate(r.teammate_id)
        return (
          <ListRow
            key={r.id}
            leading={tm ? <TeammateAvatar teammate={tm} size={32} interactive={false} /> : undefined}
            title={`${tm?.name ?? 'A teammate'} · ${ws.threadTitle(r.thread_id)}`}
            subtitle={doing[r.id] ? `${doing[r.id][0].toUpperCase()}${doing[r.id].slice(1)}` : 'Working…'}
            chevron
            onPress={() => router.push({ pathname: '/chat/[threadId]', params: { threadId: r.thread_id } })}
            style={{ paddingHorizontal: 16 }}
          />
        )
      }) : (
        <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 20 }}>Nobody is working right now.</Text>
      )}
    </View>
  )
}

interface Upcoming { key: string; at: string; title: string; sub: string; teammate?: string; open: () => void }

/** The next automation runs and follow-ups, soonest first. */
function ComingUp({ automations, followups }: { automations: Automation[] | null; followups: ReturnType<typeof useFollowups>['pending'] }) {
  const ws = useWorkspace()
  const items = useMemo(() => {
    const out: Upcoming[] = []
    for (const a of automations ?? []) {
      if (a.enabled && a.next_run) out.push({ key: a.id, at: a.next_run, title: a.name, sub: 'Automation', teammate: a.teammate_id, open: () => openAutomation(a.id) })
    }
    for (const f of followups ?? []) {
      const at = f.at ?? f.check_by
      if (!at) continue
      out.push({
        key: f.id, at, title: f.what, sub: `Follow-up · ${ws.threadTitle(f.thread_id)}`, teammate: f.owner === 'group' ? undefined : f.owner,
        open: () => router.push({ pathname: '/chat/[threadId]', params: { threadId: f.thread_id } }),
      })
    }
    return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 5)
  }, [automations, followups, ws])

  if (automations === null || followups === null) {
    return <View style={{ paddingHorizontal: 20, gap: 14 }}><Skeleton width="65%" /><Skeleton width="45%" /></View>
  }
  if (!items.length) return <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 20 }}>Nothing scheduled.</Text>
  return (
    <View>
      {items.map((u) => {
        const tm = ws.teammate(u.teammate)
        return (
          <ListRow
            key={u.key}
            leading={tm ? <TeammateAvatar teammate={tm} size={32} interactive={false} paused /> : undefined}
            title={u.title}
            subtitle={`${whenLabel(u.at)} · ${tm ? `${tm.name} · ` : ''}${u.sub}`}
            chevron
            onPress={u.open}
            style={{ paddingHorizontal: 16 }}
          />
        )
      })}
    </View>
  )
}
