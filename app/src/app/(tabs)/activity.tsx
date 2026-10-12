import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'

import { ApprovalCard } from '@/components/approval-card'

import { ActivityRow } from '@/components/activity-row'
import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { FILTER_TYPES, matchesFilter, type ActivityFilter } from '@/lib/activity'
import { dayLabel, sameDay } from '@/lib/format'
import { liveChannel } from '@/lib/realtime'
import { supabase } from '@/lib/supabase'
import type { Activity, Approval, Teammate } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import { Button, EmptyState, Icon, Press, Segment, Skeleton, TeammateAvatar, Text, haptic } from '@/ui'

const PAGE = 40

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'tools', label: 'Tools' }, { value: 'handoffs', label: 'Handoffs' },
  { value: 'approvals', label: 'Approvals' }, { value: 'events', label: 'Events' }, { value: 'errors', label: 'Errors' },
]

const EMPTY: Record<ActivityFilter, string> = {
  all: 'Every tool call, handoff, approval and event your teammates handle shows up here as it happens.',
  tools: 'When a teammate searches, reads or runs something, it lands here.',
  handoffs: 'When one teammate passes work to another, it lands here.',
  approvals: 'Requests to send, post or push, and what you decided, land here.',
  events: 'Webhooks and schedules that woke a teammate land here.',
  errors: 'Nothing has failed. Failed steps land here with what went wrong.',
}

export default function ActivityTab() {
  const params = useLocalSearchParams<{ teammate?: string }>()
  const { c } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const [who, setWho] = useState<string | null>(params.teammate ?? null)
  const [filter, setFilter] = useState<ActivityFilter>('all')
  // Rows are tagged with the filters they were loaded for; a filter change shows skeletons until they match.
  const key = `${who}|${filter}`
  const [loaded, setLoaded] = useState<{ key: string; rows: Activity[] } | null>(null)
  const rows = loaded?.key === key ? loaded.rows : null
  const setRows = (f: (r: Activity[]) => Activity[]) => setLoaded((l) => (l && l.key === key ? { key, rows: f(l.rows) } : l))
  const [lastParam, setLastParam] = useState(params.teammate)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const loadingMore = useRef(false)

  // A profile's "See all" lands here with ?teammate=<id> (also while the tab is already mounted).
  if (params.teammate !== lastParam) {
    setLastParam(params.teammate)
    if (params.teammate) setWho(params.teammate)
  }

  const query = useCallback((before?: string) => {
    let q = supabase.from('activity').select('*').not('type', 'in', '(run_start,run_end)').order('created_at', { ascending: false }).limit(PAGE)
    if (who) q = q.eq('teammate_id', who)
    if (filter === 'errors') q = q.or('type.eq.error,status.eq.error')
    else if (filter !== 'all') q = q.in('type', FILTER_TYPES[filter])
    if (before) q = q.lt('created_at', before)
    return q
  }, [who, filter])

  const load = useCallback(() => query().then(({ data, error: e }) => {
    setError(e ? 'Unable to load activity. Check your connection and pull to refresh.' : null)
    setLoaded({ key, rows: ((data ?? []) as Activity[]).filter((a) => matchesFilter(a, filter)) })
    setMore((data ?? []).length === PAGE)
  }), [query, filter, key])

  useEffect(() => { load() }, [load])

  const loadMore = async () => {
    if (!more || loadingMore.current || !rows?.length) return
    loadingMore.current = true
    const { data } = await query(rows[rows.length - 1].created_at)
    loadingMore.current = false
    if (!data) return
    setRows((r) => [...r, ...(data as Activity[]).filter((a) => matchesFilter(a, filter) && !r.some((x) => x.id === a.id))])
    setMore(data.length === PAGE)
  }

  // Realtime: new rows slide in at the top when they match the current filters.
  useEffect(() => {
    // Self-healing (lib/realtime): after the channel died, a rejoin reloads the list.
    const live = liveChannel(() => supabase
      .channel(`activity-feed:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity' }, (e) => {
        const a = e.new as Activity
        if (who && a.teammate_id !== who) return
        if (!matchesFilter(a, filter)) return
        setLoaded((l) => (l && l.key === `${who}|${filter}` && !l.rows.some((x) => x.id === a.id) ? { ...l, rows: [a, ...l.rows] } : l))
      }), (first) => { if (!first) load() })
    return () => live.stop()
  }, [who, filter]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => { setRefreshing(true); await Promise.all([load(), ws.refresh()]); setRefreshing(false) }

  const header = (
    <View>
      <TabHeader title="Activity" />
      {/* What's waiting on you comes first; past decisions are in the feed under Approvals. */}
      {ws.pendingApprovals.length > 0 && (
        <View style={{ gap: 12, paddingBottom: 20 }}>
          <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 20 }}>
            Waiting for you · {ws.pendingApprovals.length}
          </Text>
          {ws.pendingApprovals.map((a) => <Waiting key={a.id} approval={a} />)}
        </View>
      )}
      <Filters teammates={ws.teammates} who={who} setWho={setWho} filter={filter} setFilter={setFilter} />
    </View>
  )

  return (
    <FlatList
      data={rows ?? []}
      keyExtractor={(a) => a.id}
      ListHeaderComponent={header}
      contentContainerStyle={{ paddingBottom: inset + 24 }}
      onEndReached={loadMore}
      onEndReachedThreshold={0.6}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
      renderItem={({ item, index }) => {
        const prev = rows![index - 1]
        return (
          <Animated.View entering={index < 10 && !refreshing ? FadeIn.duration(motion.duration.slow).delay(motion.staggerDelay(index)) : undefined}>
            {(!prev || !sameDay(prev.created_at, item.created_at)) && (
              <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 20, paddingTop: index ? 20 : 8, paddingBottom: 4 }}>
                {dayLabel(item.created_at)}
              </Text>
            )}
            <ActivityRow a={item} />
          </Animated.View>
        )
      }}
      ListEmptyComponent={rows === null ? <LoadingRows /> : (
        <EmptyState
          title={error ? 'Unable to load activity' : who ? `Nothing from ${ws.teammate(who)?.name ?? 'this teammate'} yet` : 'Nothing here yet'}
          body={error ?? EMPTY[filter]}
          action={who || filter !== 'all' ? <Button label="Clear filters" variant="soft" onPress={() => { setWho(null); setFilter('all') }} /> : undefined}
        />
      )}
      ListFooterComponent={rows && rows.length > 0 && more ? <ActivityIndicator color={c.ink3} style={{ paddingVertical: 16 }} accessibilityLabel="Loading older activity" /> : null}
    />
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

function LoadingRows() {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 22 }} accessible accessibilityLabel="Loading activity">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
          <Skeleton width={32} height={32} radius={16} />
          <View style={{ flex: 1, gap: 8, paddingTop: 2 }}>
            <Skeleton width={`${55 + ((i * 13) % 35)}%`} height={12} />
            <Skeleton width="30%" height={10} />
          </View>
        </View>
      ))}
    </View>
  )
}

function Filters({ teammates, who, setWho, filter, setFilter }: {
  teammates: Teammate[]
  who: string | null
  setWho: (id: string | null) => void
  filter: ActivityFilter
  setFilter: (f: ActivityFilter) => void
}) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const ring = (on: boolean) => ({ borderWidth: 2, borderColor: on ? c.tube : 'transparent', borderRadius: 26, padding: 2 })
  return (
    <View style={{ gap: 12, paddingBottom: 8 }}>
      {teammates.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }} accessibilityRole="radiogroup" accessibilityLabel="Filter by teammate">
          <Pressable
            accessibilityRole="radio"
            accessibilityLabel="Everyone"
            accessibilityState={{ checked: !who }}
            onPress={() => { haptic.tap(); setWho(null) }}
            style={{ alignItems: 'center', width: 60, gap: 4 }}
          >
            <View style={ring(!who)}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
                <Text variant="label" color={!who ? 'ink' : 'ink3'}>All</Text>
              </View>
            </View>
            <Text variant="footnote" color={!who ? 'ink' : 'ink3'}>Everyone</Text>
          </Pressable>
          {teammates.map((t) => {
            const on = who === t.id
            return (
              <Pressable
                key={t.id}
                accessibilityRole="radio"
                accessibilityLabel={t.name}
                accessibilityState={{ checked: on }}
                onPress={() => { haptic.tap(); setWho(on ? null : t.id) }}
                style={{ alignItems: 'center', width: 60, gap: 4 }}
              >
                <View style={ring(on)}><TeammateAvatar teammate={t} size={40} interactive={false} paused={!on} /></View>
                <Text variant="footnote" color={on ? 'ink' : 'ink3'} numberOfLines={1}>{t.name}</Text>
              </Pressable>
            )
          })}
        </ScrollView>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
        <View style={{ width: Math.max(width - 32, 540) }}>
          <Segment<ActivityFilter> value={filter} onChange={setFilter} options={FILTERS} accessibilityLabel="Filter by type" />
        </View>
      </ScrollView>
    </View>
  )
}
