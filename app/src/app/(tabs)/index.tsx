import { router } from 'expo-router'
import { useRef, useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Add01Icon, ArrowRight01Icon, CheckListIcon, NotificationOff02Icon, Settings01Icon, UserGroupIcon,
} from '@hugeicons/core-free-icons'

import { HeaderSearch } from '@/components/header-search'
import { useChatNotify } from '@/components/notify-prefs'
import { useTabBarInset } from '@/components/tab-bar'
import { ThreadAvatar } from '@/components/thread-avatar'
import { openSheet } from '@/components/sheet-screen'
import { isUnread, plainText, relativeTime } from '@/lib/format'
import type { Thread } from '@/lib/types'
import { chatTitle, isComputer, useWorkspace, type Preview } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import {
  AvatarStack, Button, EmptyState, Icon, Press, Skeleton, TeammateAvatar, Text, showMenu,
} from '@/ui'

const openThread = (threadId: string) => router.push({ pathname: '/chat/[threadId]', params: { threadId } })

export default function Chats() {
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState('')
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 8 }}>
        <HeaderSearch value={query} onChange={setQuery} placeholder="Search chats" />
      </View>
      <Inbox query={query} />
    </View>
  )
}

/**
 * The end of the inbox: your crew's faces and a quiet line about where they are (the ones on a run are at work, the
 * rest "in the break room"). Opens the crew.
 */
function CrewRow() {
  const ws = useWorkspace()
  const busy = new Set(ws.liveRuns.filter((r) => r.status === 'running').map((r) => r.teammate_id ?? ''))
  const n = ws.teammates.filter((t) => busy.has(t.id)).length
  const line = n === 0 ? 'The crew’s in the break room'
    : n === ws.teammates.length ? 'The whole crew’s at work. Rare sight'
      : `${n} at work, the rest in the break room`
  return (
    <Press
      radius={20}
      onPress={() => router.push('/crew')}
      accessibilityLabel={`${line}. ${ws.teammates.length} teammates`}
      accessibilityHint="Opens your crew"
      outerStyle={{ alignSelf: 'center', marginTop: 28 }}
      style={{ alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 14 }}
    >
      <AvatarStack teammates={ws.teammates} size={30} max={5} working={busy} />
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Text variant="footnote" color="ink3">That’s every chat.</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text variant="label" color="ink2">{line}</Text>
          <Icon icon={ArrowRight01Icon} size={14} color="ink3" />
        </View>
      </View>
    </Press>
  )
}

function Inbox({ query }: { query: string }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const [refreshing, setRefreshing] = useState(false)
  const list = useRef<FlatList<Thread>>(null)
  const refresh = async () => { setRefreshing(true); await ws.refresh(); setRefreshing(false) }

  const q = query.trim().toLowerCase()
  // One row per teammate: its most recently active chat stands for all of them (the chat screen switches between them).
  const threads = [...ws.threads]
    .sort((a, b) => Date.parse(b.last_message_at ?? b.created_at) - Date.parse(a.last_message_at ?? a.created_at))
    .filter((t, i, all) => t.kind !== 'dm' || all.findIndex((x) => x.kind === 'dm' && x.teammate_id === t.teammate_id) === i)
    .filter((t) => !q || [t, ...(t.kind === 'dm' ? ws.chatsWith(t.teammate_id!) : [])]
      .some((x) => `${ws.threadTitle(x.id)} ${x.title ?? ''} ${ws.previews[x.id]?.text ?? ''}`.toLowerCase().includes(q)))

  if (ws.loading) {
    return (
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 20 }} accessible accessibilityLabel="Loading chats">
        {[0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Skeleton width={48} height={48} radius={16} />
            <View style={{ flex: 1, gap: 8 }}>
              <Skeleton width={`${40 + ((i * 17) % 30)}%`} height={12} />
              <Skeleton width={`${60 + ((i * 11) % 25)}%`} height={10} />
            </View>
          </View>
        ))}
      </View>
    )
  }

  if (ws.teammates.length === 0) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', paddingBottom: inset }}>
        <EmptyState
          title={ws.error ? 'Unable to load your chats' : 'Hire your first teammate'}
          body={ws.error ?? 'Teammates have a role, memory and the tools you allow. You chat with each one here, or group them into projects.'}
          art={<TeammateAvatar teammate={{ name: 'Teammate', avatar_shape: 'clover', color: c.tube }} size={64} state="sleeping" />}
          action={ws.error
            ? <Button label="Try again" variant="soft" onPress={refresh} />
            : <Button label="Create a teammate" icon={Add01Icon} onPress={() => openSheet('teammate')} />}
        />
      </View>
    )
  }

  return (
    <FlatList
      ref={list}
      data={threads}
      // Showing the saved copy: say so quietly (WhatsApp's "Connecting…"); pull to refresh tries again.
      ListHeaderComponent={ws.offline ? (
        <Animated.View entering={FadeIn.duration(motion.duration.quick)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingBottom: 8 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.ink3 }} />
          <Text variant="footnote" color="ink3">Waiting for connection</Text>
        </Animated.View>
      ) : null}
      keyExtractor={(t) => t.id}
      contentContainerStyle={{ paddingBottom: inset + 96 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
      renderItem={({ item, index }) => (
        <Animated.View entering={index < 8 ? FadeIn.duration(motion.duration.slow).delay(motion.staggerDelay(index)) : undefined}>
          <ChatRow thread={item} />
        </Animated.View>
      )}
      ListEmptyComponent={q ? <EmptyState title="No chats match" body={`Nothing in your inbox matches "${query.trim()}".`} /> : null}
      ListFooterComponent={q ? null : <>
      <CrewRow />
      {ws.projects.length === 0 && (
        <Press radius={16} onPress={() => openSheet('project')} outerStyle={{ marginHorizontal: 16, marginTop: 12 }} style={{ padding: 16, borderWidth: 1, borderColor: c.line, borderStyle: 'dashed', flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
            <Icon icon={UserGroupIcon} size={20} color="ink2" />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium">Start a project</Text>
            <Text variant="caption" color="ink3">A group chat where several teammates work together.</Text>
          </View>
        </Press>
      )}
      </>}
    />
  )
}

function previewText(p: Preview | undefined, thread: Thread, name: (id: string | null) => string | undefined) {
  if (!p) return thread.kind === 'dm' ? 'No messages yet' : 'No messages yet. Say hello to the team.'
  const who = p.sender_type === 'user' ? 'You: ' : thread.kind === 'project' && p.sender_type === 'teammate' && p.kind === 'text' ? `${name(p.teammate_id) ?? 'Teammate'}: ` : ''
  const body = p.kind === 'error' ? 'A run failed' : plainText(p.text)
  return who + body
}

function ChatRow({ thread }: { thread: Thread }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const title = ws.threadTitle(thread.id)
  const p = ws.previews[thread.id]
  // A teammate's row speaks for all its chats: new or waiting in any of them shows here.
  const chats = thread.kind === 'dm' ? ws.chatsWith(thread.teammate_id!) : [thread]
  const ids = new Set(chats.map((x) => x.id))
  const unread = chats.some(isUnread)
  const pending = ws.pendingApprovals.filter((a) => ids.has(a.thread_id)).length
  const working = ws.liveRuns.find((r) => ids.has(r.thread_id) && r.status === 'running')
  const workerName = working && ws.teammate(working.teammate_id)?.name

  // A DM's title is already the teammate's name; a group says who.
  const sub = working
    ? (thread.id.startsWith('dm:') || !workerName ? 'Working' : `${workerName} is working`)
    : pending
      ? `Waiting for your approval`
      : (chats.length > 1 ? `${chatTitle(thread)} · ` : '') + previewText(p, thread, (id) => ws.teammate(id)?.name)

  const people = ws.threadTeammates(thread.id)
  const notify = useChatNotify(thread.id, title)
  const subtitleColor = working || pending ? 'tube' : unread ? 'ink2' : 'ink3'

  return (
    <>
    <Press
      radius={16}
      static
      onPress={() => openThread(thread.id)}
      onLongPress={() => showMenu({
        title,
        items: [
          ...(unread ? [{ label: 'Mark as read', icon: CheckListIcon, onPress: () => chats.filter(isUnread).forEach((x) => ws.markRead(x.id)) }] : []),
          thread.kind === 'dm'
            ? { label: people[0] && isComputer(people[0]) ? 'Computer details' : 'View profile', icon: Settings01Icon, onPress: () => router.push({ pathname: '/teammate/[id]', params: { id: thread.teammate_id! } }) }
            : { label: 'Project settings', icon: Settings01Icon, onPress: () => router.push({ pathname: '/project/[id]/settings', params: { id: thread.project_id! } }) },
          notify.item,
        ],
      })}
      accessibilityLabel={`${title}${unread ? ', unread' : ''}. ${sub}${p ? `. ${relativeTime(p.created_at)}` : ''}`}
      accessibilityHint="Opens the chat"
      outerStyle={{ marginHorizontal: 8 }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 10, minHeight: 72 }}
    >
      <ThreadAvatar threadId={thread.id} size={48} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="headline" numberOfLines={1} style={{ flexShrink: 1, fontSize: 16 }}>{title}</Text>
          {thread.kind === 'project' && <Text variant="footnote" color="ink3" tabular>{people.length}</Text>}
          {notify.muted && <Icon icon={NotificationOff02Icon} size={14} color="ink3" />}
          <View style={{ flex: 1 }} />
          {(p || thread.last_message_at) && (
            <Text variant="footnote" tabular color={unread ? 'tube' : 'ink3'}>{relativeTime(p?.created_at ?? thread.last_message_at!)}</Text>
          )}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="caption" color={subtitleColor} numberOfLines={1} style={{ flex: 1 }}>{sub}</Text>
          {(unread || pending > 0) && (
            <View style={{ minWidth: 10, height: 10, borderRadius: 5, backgroundColor: c.tube }} accessibilityElementsHidden />
          )}
        </View>
      </View>
    </Press>
    {notify.sheet}
    </>
  )
}
