import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import { ArrowDown01Icon, InformationCircleIcon } from '@hugeicons/core-free-icons'

import { Composer } from '@/components/chat/composer'
import { ComputerInfo } from '@/components/chat/computer-info'
import { FollowupsButton, FollowupsSheet, useFollowups } from '@/components/chat/followups'
import { VoiceControls, unsavedTurns, useVoiceSession } from '@/components/voice/voice-mode'
import { ChatActionsContext, ChatRow, senderOf, timeOf, type ChatActions, type ChatItem } from '@/components/chat/message-row'
import { ScreenHeader } from '@/components/screen-header'
import { ThreadAvatar } from '@/components/thread-avatar'
import { api } from '@/lib/api'
import { dayLabel, sameDay } from '@/lib/format'
import { useSession } from '@/lib/session'
import { useThread, type ChatMessage, type LiveStatus, type SendOptions } from '@/lib/use-thread'
import { computerId, isComputer, useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import { Button, EmptyState, Icon, IconButton, Press, Skeleton, TeammateAvatar, Text, TextSwap, elevation, haptic, toast } from '@/ui'

const GROUP_GAP_MS = 5 * 60_000

export default function Thread() {
  const { threadId: raw } = useLocalSearchParams<{ threadId: string }>()
  const threadId = decodeURIComponent(raw ?? '')
  const { c, scheme } = useTheme()
  const ws = useWorkspace()
  const { session } = useSession()
  const t = useThread(threadId, session?.user.id)

  const isDm = threadId.startsWith('dm:')
  const people = ws.threadTeammates(threadId)
  const dmMate = isDm ? people[0] : undefined
  const project = isDm ? undefined : ws.project(threadId.slice(5))
  const title = ws.threadTitle(threadId)
  // A linked computer's chat: its slash commands and a live status strip (agent computers.py).
  const computer = dmMate && isComputer(dmMate) ? computerId(dmMate) : null
  const [commands, setCommands] = useState<{ name: string; about: string; arg: boolean }[] | undefined>()
  const [info, setInfo] = useState(false)
  useEffect(() => {
    if (computer) api<{ name: string; about: string; arg: boolean }[]>('/computers/commands').then(setCommands, () => {})
  }, [computer])
  // A chat made by the service (a linked computer's) can arrive before its teammate is loaded here.
  const missing = isDm && !dmMate && !ws.loading
  useEffect(() => { if (missing) ws.refresh() }, [missing])  // eslint-disable-line react-hooks/exhaustive-deps
  const liveRuns = ws.liveRuns.filter((r) => r.thread_id === threadId)
  const [voice, setVoice] = useState(false)
  const v = useVoiceSession({
    enabled: voice, threadId, messages: t.messages, working: liveRuns.some((r) => r.status === 'running'),
    activity: Object.values(t.statuses).find((st) => st.label)?.label, name: dmMate?.name ?? title,
    onTask: (text) => t.send(text, [], { voiceTask: true }), onEnd: () => setVoice(false),
  })
  const insets = useSafeAreaInsets()
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
  // One indicator per teammate: a message that arrives while a run is busy queues as a second "running" run, and two
  // pills for the same teammate read as a glitch. A live status (with its label) wins over the queued fallback.
  const perMate = new Map<string, LiveStatus>()
  for (const st of statusFor.values()) {
    const had = perMate.get(st.teammate_id)
    if (!had || (!had.label && st.label)) perMate.set(st.teammate_id, st)
  }
  const liveItems: ChatItem[] = [
    ...[...perMate.values()]
      // Hide while text streams, and keep hiding "writing" after `done` until the DB row swaps in.
      .filter((s) => !ghosts.some((g) => g.run_id === s.run_id && (!g.done || s.state === 'writing')))
      .filter((s) => s.state !== 'waiting' || !Object.values(t.approvals).some((a) => a.run_id === s.run_id && a.status === 'pending'))
      .map((s) => ({ type: 'status' as const, key: `r:${s.run_id}`, s })),
    ...ghosts.map((g) => ({ type: 'ghost' as const, key: `s:${g.stream_id}`, g })),
  ]
  // Cards that have been dealt with leave the chat (messages are newest first):
  // - a task live voice handed over: the spoken words are saved as the conversation instead;
  // - an error once the teammate has since replied (it got sorted, so Retry means nothing now);
  // - a request that expired unanswered (a newer message replaced it). Approved and rejected cards stay as a record.
  const shown = (m: ChatMessage, i: number) => {
    if (m.meta?.voice_task) return false
    if (m.kind === 'error') return !t.messages.slice(0, i).some((n) => n.sender_type === 'teammate' && n.kind === 'text')
    const a = m.meta?.approval_id ? t.approvals[m.meta.approval_id] : undefined
    return a?.status !== 'expired'
  }
  // Voice mode is this chat, spoken: what's being said (and turns not saved yet) shows as messages at the bottom.
  const speaker = dmMate?.id ?? people[0]?.id ?? ''
  const voiceItems: ChatItem[] = voice ? unsavedTurns(v, t.messages).reverse().map((turn, i, all) => {
    const key = turn === v.live ? 'voice:live' : `voice:${all.length - i}`
    return turn.role === 'user'
      ? { type: 'message' as const, key, m: { id: key, thread_id: threadId, owner_id: '', sender_type: 'user' as const, teammate_id: null, text: turn.text, mentions: [], kind: 'text' as const, meta: { voice: true }, proactive: false, run_id: null, created_at: new Date().toISOString() } as ChatMessage }
      : { type: 'ghost' as const, key, g: { stream_id: key, run_id: 'voice', teammate_id: speaker, text: turn.text, done: turn !== v.live } }
  }) : []
  const items: ChatItem[] = [
    ...voiceItems,
    ...liveItems,
    ...t.messages.filter((m, i) => shown(m, i)).map((m) => ({ type: 'message' as const, key: m.meta?.stream_id ? `s:${m.meta.stream_id}` : m.id, m })),
  ]

  // One retry at a time: a second tap while the first is on its way would start a second run.
  const retrying = useRef(false)
  const retryRun = async () => {
    const lastUser = t.messages.find((m) => m.sender_type === 'user' && !m.local)
    if (!lastUser) return toast({ title: 'Nothing to retry', body: 'Send a new message instead.' })
    if (retrying.current) return
    retrying.current = true
    const err = await t.rerun(lastUser)
    retrying.current = false
    if (err) toast({ title: 'Unable to retry', body: err, tone: 'error' })
  }

  const stop = async () => {
    try {
      await Promise.all(liveRuns.map((r) => api(`/runs/${r.id}/cancel`, { method: 'POST' })))
    } catch (e) {
      toast({ title: 'Unable to stop', body: e instanceof Error ? e.message : undefined, tone: 'error' })
    }
  }

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [showFollowups, setShowFollowups] = useState(false)
  const list = useRef<FlatList<ChatItem>>(null)
  // The composer floats over the chat (which scrolls under its fade): the list keeps its height clear.
  const [composerH, setComposerH] = useState(64)

  // Scrolled up past the latest messages: a round ↓ button jumps back (with a dot when something new came in).
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)
  const awayRef = useRef(false)
  const toLatest = () => { list.current?.scrollToOffset({ offset: 0, animated: true }); setFresh(false) }
  const newestKey = items[0]?.key
  useEffect(() => { if (awayRef.current && newestKey) setFresh(true) }, [newestKey])

  const send = async (text: string, mentions: string[], opts: SendOptions = {}) => {
    toLatest()  // what you just sent is at the bottom: go there, like any chat app
    const err = await t.send(text, mentions, { ...opts, reply_to: replyTo?.id ?? null })
    setReplyTo(null)
    if (err) toast({ title: 'Message not sent', body: err, tone: 'error' })
  }

  // Handlers read the latest render through a ref, so the context value (and every memoised row) stays put.
  const latest = useRef({ t, items, retryRun, ws })
  useLayoutEffect(() => { latest.current = { t, items, retryRun, ws } })
  // Stable across renders (the React Compiler memoises it on handleKey), so memoised rows don't re-render per delta.
  const handleKey = people.map((p) => p.handle.toLowerCase()).join(',')
  const ctx: ChatActions = {
    onReply: (m) => setReplyTo(m),
    jumpTo: (id) => {
      const index = latest.current.items.findIndex((i) => i.type === 'message' && i.m.id === id)
      if (index < 0) return
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true })
      setHighlight(id)
      setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1400)
    },
    onRetryMessage: async (m) => { const err = await latest.current.t.retry(m); if (err) toast({ title: 'Message not sent', body: err, tone: 'error' }) },
    onDiscardMessage: (m) => latest.current.t.discard(m.id),
    onRetryRun: () => latest.current.retryRun(),
    onDecided: () => { latest.current.t.refreshApprovals(); latest.current.ws.refresh() },
    onReact: (m, emoji) => latest.current.t.react(m, emoji),
    handles: new Set([...handleKey.split(','), ...(isDm ? [] : ['all', 'everyone']), ...(commands ?? []).map((x) => `/${x.name}`)]),
    group: !isDm,
    onSend: async (text) => { const err = await latest.current.t.send(text, []); if (err) toast({ title: 'Message not sent', body: err, tone: 'error' }) },
  }
  const byId = new Map(t.messages.map((m) => [m.id, m]))

  // ---- header
  // Follow-ups change when a run ends (a teammate or the keeper set, fired or cancelled one): reload then.
  const running = liveRuns.some((r) => r.status === 'running')
  const fu = useFollowups(threadId, running)
  const working = liveRuns.find((r) => r.status === 'running')
  const workerName = working && ws.teammate(working.teammate_id)?.name
  const subtitle = working
    ? (isDm || !workerName ? 'Working' : `${workerName} is working`)
    : isDm ? dmMate?.role ?? '' : people.length ? people.map((p) => p.name).join(', ') : 'No members yet'
  const openDetails = () => {
    if (dmMate && isComputer(dmMate)) router.push({ pathname: '/computers', params: { open: computerId(dmMate)! } })
    else if (dmMate) router.push({ pathname: '/teammate/[id]', params: { id: dmMate.id } })
    else if (project) router.push({ pathname: '/project/[id]/settings', params: { id: project.id } })
  }

  const header = (
    <ScreenHeader
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {computer && <IconButton icon={InformationCircleIcon} round accessibilityLabel={`About ${title}`} onPress={() => setInfo(true)} />}
          <FollowupsButton count={fu.list.length} onPress={() => { fu.load(); setShowFollowups(true) }} />
        </View>
      }
      middle={
        <Press
          radius={12}
          static
          onPress={openDetails}
          accessibilityLabel={`${title}. ${subtitle}`}
          accessibilityHint={dmMate && isComputer(dmMate) ? 'Opens the computer' : isDm ? 'Opens the teammate profile' : 'Opens project settings'}
          // Room on the left for the avatar's working ring (3pt outside it), which the rounded press area would clip.
          outerStyle={{ marginLeft: -4 }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, paddingLeft: 4, paddingRight: 8 }}
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

  const workingIds = liveRuns.filter((r) => r.status === 'running').map((r) => r.teammate_id)
  const proactiveRuns = liveRuns.filter((r) => r.trigger === 'event' || r.trigger === 'schedule').map((r) => r.id)
  const rowProps = (index: number) => {
    const item = items[index]
    const older = items[index + 1]
    const newer = items[index - 1]
    const olderTime = older ? timeOf(older) : null
    const time = timeOf(item)
    const newDay = !older ? (!t.hasMore ? dayLabel(time) : null) : !sameDay(olderTime!, time) ? dayLabel(time) : null
    const joins = (a: ChatItem, b: ChatItem) => senderOf(a) === senderOf(b) && senderOf(a) !== 'system'
      && sameDay(timeOf(a), timeOf(b)) && Math.abs(Date.parse(timeOf(a)) - Date.parse(timeOf(b))) <= GROUP_GAP_MS
    const m = item.type === 'message' ? item.m : undefined
    return {
      firstInGroup: !older || !!newDay || !joins(older, item),
      lastInGroup: !newer || !joins(item, newer),
      dayBreak: newDay,
      pauseAvatar: index > 12,
      approval: m?.meta.approval_id ? t.approvals[m.meta.approval_id] : undefined,
      replyTo: m?.reply_to ? byId.get(m.reply_to) ?? null : undefined,
      highlighted: !!m && m.id === highlight,
      working: workingIds.includes(senderOf(item).slice(3)),
      proactive: item.type === 'ghost' && proactiveRuns.includes(item.g.run_id),
    }
  }

  const empty = (
    <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 24 + composerH }}>
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
      <ChatActionsContext.Provider value={ctx}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {/* In flow, so it shrinks above the keyboard; the composer is pinned to its bottom (absolute children skip the padding). */}
        <View style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
        {t.loading ? (
          <View style={{ flex: 1, justifyContent: 'flex-end', padding: 16, paddingBottom: 16 + composerH, gap: 18 }} accessible accessibilityLabel="Loading messages">
            <View style={{ flexDirection: 'row', gap: 10 }}><Skeleton width={28} height={28} radius={14} /><View style={{ flex: 1, gap: 8 }}><Skeleton width="30%" /><Skeleton width="85%" /><Skeleton width="60%" /></View></View>
            <View style={{ alignItems: 'flex-end' }}><Skeleton width="55%" height={36} radius={18} /></View>
            <View style={{ flexDirection: 'row', gap: 10 }}><Skeleton width={28} height={28} radius={14} /><View style={{ flex: 1, gap: 8 }}><Skeleton width="25%" /><Skeleton width="70%" /></View></View>
          </View>
        ) : t.error ? (
          <View style={{ flex: 1, justifyContent: 'center', paddingBottom: composerH }}>
            <EmptyState title="Unable to load this chat" body={t.error} action={<Button label="Try again" variant="soft" onPress={t.reload} />} />
          </View>
        ) : items.length === 0 ? (
          // Rendered outside the inverted list, which flips its children on Android.
          empty
        ) : (
          <FlatList
            ref={list}
            data={items}
            inverted
            keyExtractor={(i) => i.key}
            renderItem={({ item, index }) => <ChatRow item={item} {...rowProps(index)} />}
            onScrollToIndexFailed={(e) => list.current?.scrollToOffset({ offset: e.averageItemLength * e.index, animated: true })}
            initialNumToRender={14}
            maxToRenderPerBatch={8}
            windowSize={11}
            contentContainerStyle={{ paddingTop: 12 + composerH, paddingBottom: 8, flexGrow: 1 }}
            onEndReached={t.loadOlder}
            onEndReachedThreshold={0.4}
            ListFooterComponent={t.loadingOlder ? <ActivityIndicator style={{ padding: 16 }} color={c.ink3} /> : null}
            maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 120 }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={64}
            onScroll={(e) => {
              const a = e.nativeEvent.contentOffset.y > 320  // inverted: 0 is the latest message
              if (a !== awayRef.current) { awayRef.current = a; setAway(a); if (!a) setFresh(false) }
            }}
          />
        )}
        </View>
        {away && (
          <Animated.View entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.fast)}
            style={{ position: 'absolute', right: 16, bottom: composerH + 10 }}>
            <Press radius={20} onPress={() => { haptic.tap(); toLatest() }} accessibilityLabel={fresh ? 'New messages. Jump to the latest' : 'Jump to the latest'}
              style={[{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line }, elevation(scheme)]}>
              <Icon icon={ArrowDown01Icon} size={20} color="ink" />
              {fresh && <View style={{ position: 'absolute', top: 2, right: 2, width: 9, height: 9, borderRadius: 5, backgroundColor: c.tube }} />}
            </Press>
          </Animated.View>
        )}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }} onLayout={(e) => setComposerH(Math.round(e.nativeEvent.layout.height))}>
        {voice ? (
          <View style={{ backgroundColor: c.canvas }}>
            <VoiceControls v={v} name={dmMate?.name ?? title} padBottom={insets.bottom} onEnd={() => setVoice(false)} onType={() => setVoice(false)} />
          </View>
        ) : <Composer
          placeholder={isDm ? `Message ${dmMate?.name ?? ''}` : people.length ? 'Message the team' : 'Message the project'}
          members={isDm ? [] : people}
          live={live}
          onSend={send}
          onStop={stop}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onVoice={() => setVoice(true)}
          commands={computer ? commands ?? [] : undefined}
        />}
        </View>
        </View>
      </KeyboardAvoidingView>
      </ChatActionsContext.Provider>
      {computer && <ComputerInfo open={info} onClose={() => setInfo(false)} id={computer} name={title} onCommand={(cmd) => send(cmd, [])} />}
      <FollowupsSheet
        open={showFollowups}
        onClose={() => setShowFollowups(false)}
        list={fu.list}
        done={fu.done}
        people={isDm ? (dmMate ? [dmMate] : []) : people}
        onCancel={fu.cancel}
      />
    </View>
  )
}
