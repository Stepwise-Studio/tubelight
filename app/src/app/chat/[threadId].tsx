import { router, useLocalSearchParams } from 'expo-router'
import { useEffect } from 'react'
import { ActivityIndicator, FlatList, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'

import { Composer } from '@/components/chat/composer'
import { ChatRow, senderOf, timeOf, type ChatItem, type RowContext } from '@/components/chat/message-row'
import { ScreenHeader } from '@/components/screen-header'
import { ThreadAvatar } from '@/components/thread-avatar'
import { api } from '@/lib/api'
import { dayLabel, sameDay } from '@/lib/format'
import { useSession } from '@/lib/session'
import { useThread, type LiveStatus } from '@/lib/use-thread'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Button, EmptyState, Press, Skeleton, TeammateAvatar, Text, TextSwap, toast } from '@/ui'

const GROUP_GAP_MS = 5 * 60_000

export default function Thread() {
  const { threadId: raw } = useLocalSearchParams<{ threadId: string }>()
  const threadId = decodeURIComponent(raw ?? '')
  const { c } = useTheme()
  const ws = useWorkspace()
  const { session } = useSession()
  const t = useThread(threadId, session?.user.id)

  const isDm = threadId.startsWith('dm:')
  const people = ws.threadTeammates(threadId)
  const dmMate = isDm ? people[0] : undefined
  const project = isDm ? undefined : ws.project(threadId.slice(5))
  const title = ws.threadTitle(threadId)
  const liveRuns = ws.liveRuns.filter((r) => r.thread_id === threadId)
  const live = liveRuns.length > 0

  // Mark read on open and whenever something new lands while it's open.
  const newest = t.messages[0]?.created_at
  useEffect(() => { if (threadId) ws.markRead(threadId) }, [threadId, newest]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- items, newest first: live rows (status / ghost) then messages.
  const statusFor = new Map<string, LiveStatus>(Object.entries(t.statuses))
  for (const r of liveRuns) {
    if (!statusFor.has(r.id) && r.teammate_id) {
      statusFor.set(r.id, { run_id: r.id, teammate_id: r.teammate_id, state: r.status === 'waiting_approval' ? 'waiting' : 'thinking' })
    }
  }
  const ghosts = Object.values(t.ghosts)
  // Index 0 sits at the bottom. A run shows its indicator until its text starts streaming
  // (same slot); a run waiting on an approval card already on screen shows nothing extra.
  const liveItems: ChatItem[] = [
    ...[...statusFor.values()]
      // Hide while text streams, and keep hiding "writing" after `done` until the DB row swaps in.
      .filter((s) => !ghosts.some((g) => g.run_id === s.run_id && (!g.done || s.state === 'writing')))
      .filter((s) => s.state !== 'waiting' || !Object.values(t.approvals).some((a) => a.run_id === s.run_id && a.status === 'pending'))
      .map((s) => ({ type: 'status' as const, key: `r:${s.run_id}`, s })),
    ...ghosts.map((g) => ({ type: 'ghost' as const, key: `s:${g.stream_id}`, g })),
  ]
  const items: ChatItem[] = [
    ...liveItems,
    ...t.messages.map((m) => ({ type: 'message' as const, key: m.meta?.stream_id ? `s:${m.meta.stream_id}` : m.id, m })),
  ]

  const handles = new Set(people.map((p) => p.handle.toLowerCase()))

  const retryRun = async () => {
    const lastUser = t.messages.find((m) => m.sender_type === 'user' && !m.local)
    if (!lastUser) return toast({ title: 'Nothing to retry', body: 'Send a new message instead.' })
    const err = await t.send(lastUser.text, lastUser.mentions)
    if (err) toast({ title: 'Unable to retry', body: err, tone: 'error' })
  }

  const stop = async () => {
    try {
      await Promise.all(liveRuns.map((r) => api(`/runs/${r.id}/cancel`, { method: 'POST' })))
    } catch (e) {
      toast({ title: 'Unable to stop', body: e instanceof Error ? e.message : undefined, tone: 'error' })
    }
  }

  const send = async (text: string, mentions: string[]) => {
    const err = await t.send(text, mentions)
    if (err) toast({ title: 'Message not sent', body: err, tone: 'error' })
  }

  // ---- header
  const working = liveRuns.find((r) => r.status === 'running')
  const workerName = working && ws.teammate(working.teammate_id)?.name
  const subtitle = working
    ? `${isDm ? 'Working' : `${workerName ?? 'A teammate'} is working`}`
    : isDm ? dmMate?.role ?? '' : people.length ? people.map((p) => p.name).join(', ') : 'No members yet'
  const openDetails = () => {
    if (dmMate) router.push({ pathname: '/teammate/[id]', params: { id: dmMate.id } })
    else if (project) router.push({ pathname: '/project/[id]/settings', params: { id: project.id } })
  }

  const header = (
    <ScreenHeader
      middle={
        <Press
          radius={12}
          static
          onPress={openDetails}
          accessibilityLabel={`${title}. ${subtitle}`}
          accessibilityHint={isDm ? 'Opens the teammate profile' : 'Opens project settings'}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, paddingRight: 8 }}
        >
          <ThreadAvatar threadId={threadId} size={36} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="headline" numberOfLines={1}>{title}</Text>
            <TextSwap variant="footnote" color={working ? 'tube' : 'ink3'}>{subtitle}</TextSwap>
          </View>
        </Press>
      }
    />
  )

  if (!ws.loading && !ws.thread(threadId) && !dmMate && !project) {
    return (
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <ScreenHeader title="Chat not found" />
        <EmptyState title="This chat no longer exists" body="The teammate or project may have been deleted." action={<Button label="Back to chats" variant="soft" onPress={() => router.replace('/')} />} />
      </View>
    )
  }

  const ctxFor = (index: number): RowContext => {
    const item = items[index]
    const older = items[index + 1]
    const olderTime = older ? timeOf(older) : null
    const time = timeOf(item)
    const newDay = !older ? (!t.hasMore ? dayLabel(time) : null) : !sameDay(olderTime!, time) ? dayLabel(time) : null
    const firstInGroup = !older || !!newDay || senderOf(older) !== senderOf(item) || senderOf(item) === 'system'
      || Date.parse(time) - Date.parse(olderTime!) > GROUP_GAP_MS
    return {
      firstInGroup,
      dayBreak: newDay,
      pauseAvatar: index > 12,
      liveThread: live,
      approvals: t.approvals,
      onRetryMessage: async (m) => { const err = await t.retry(m); if (err) toast({ title: 'Message not sent', body: err, tone: 'error' }) },
      onDiscardMessage: (m) => t.discard(m.id),
      onRetryRun: retryRun,
      onApprovalDecided: () => { t.refreshApprovals(); ws.refresh() },
      mentionHandles: handles,
    }
  }

  const empty = (
    <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 24 }}>
      <EmptyState
        art={dmMate ? <TeammateAvatar teammate={dmMate} size={72} /> : <ThreadAvatar threadId={threadId} size={72} interactive />}
        title={isDm ? `Message ${dmMate?.name ?? 'your teammate'}` : `Talk to the ${title} team`}
        body={isDm
          ? dmMate?.bio || `Ask ${dmMate?.name ?? 'them'} for anything in their role. Risky actions wait for your approval.`
          : people.length
            ? `Everyone here can pick it up. @mention someone to ask them directly: ${people.map((p) => `@${p.handle}`).join(', ')}.`
            : 'Add teammates in project settings, then give them work here.'}
        action={!isDm && !people.length ? <Button label="Add teammates" variant="soft" onPress={openDetails} /> : undefined}
      />
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      {header}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {t.loading ? (
          <View style={{ flex: 1, justifyContent: 'flex-end', padding: 16, gap: 18 }} accessible accessibilityLabel="Loading messages">
            <View style={{ flexDirection: 'row', gap: 10 }}><Skeleton width={28} height={28} radius={14} /><View style={{ flex: 1, gap: 8 }}><Skeleton width="30%" /><Skeleton width="85%" /><Skeleton width="60%" /></View></View>
            <View style={{ alignItems: 'flex-end' }}><Skeleton width="55%" height={36} radius={18} /></View>
            <View style={{ flexDirection: 'row', gap: 10 }}><Skeleton width={28} height={28} radius={14} /><View style={{ flex: 1, gap: 8 }}><Skeleton width="25%" /><Skeleton width="70%" /></View></View>
          </View>
        ) : t.error ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState title="Unable to load this chat" body={t.error} action={<Button label="Try again" variant="soft" onPress={t.reload} />} />
          </View>
        ) : items.length === 0 ? (
          // Rendered outside the inverted list, which flips its children on Android.
          empty
        ) : (
          <FlatList
            data={items}
            inverted
            keyExtractor={(i) => i.key}
            renderItem={({ item, index }) => <ChatRow item={item} ctx={ctxFor(index)} />}
            contentContainerStyle={{ paddingTop: 12, paddingBottom: 8, flexGrow: 1 }}
            onEndReached={t.loadOlder}
            onEndReachedThreshold={0.4}
            ListFooterComponent={t.loadingOlder ? <ActivityIndicator style={{ padding: 16 }} color={c.ink3} /> : null}
            maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 120 }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          />
        )}
        <Composer
          placeholder={isDm ? `Message ${dmMate?.name ?? ''}` : people.length ? 'Message the team, @ to mention' : 'Message the project'}
          members={isDm ? [] : people}
          live={live}
          onSend={send}
          onStop={stop}
        />
      </KeyboardAvoidingView>
    </View>
  )
}
