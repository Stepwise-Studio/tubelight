import { router } from 'expo-router'
import { useRef, useState } from 'react'
import { FlatList, RefreshControl, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn, useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Add01Icon, BubbleChatIcon, CheckListIcon, Settings01Icon, UserAdd01Icon, UserGroupIcon,
} from '@hugeicons/core-free-icons'

import { CrewList } from '@/components/crew'
import { FabMenu } from '@/components/fab-menu'
import { useTabBarInset } from '@/components/tab-bar'
import { ThreadAvatar } from '@/components/thread-avatar'
import { isUnread, relativeTime, stripCues } from '@/lib/format'
import type { Thread } from '@/lib/types'
import { useWorkspace, type Preview } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import {
  Button, EmptyState, Icon, ListRow, Logo, Press, SearchField, Segment, Sheet, Skeleton, TeammateAvatar, Text, showMenu,
} from '@/ui'

const openThread = (threadId: string) => router.push({ pathname: '/chat/[threadId]', params: { threadId } })

type Page = 'inbox' | 'crew'
const PAGES: Page[] = ['inbox', 'crew']

export default function Chats() {
  const ws = useWorkspace()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const [page, setPage] = useState<Page>('inbox')
  const [query, setQuery] = useState('')
  const [picker, setPicker] = useState(false)
  const pager = useRef<Animated.ScrollView>(null)
  const progress = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((e) => { progress.value = e.contentOffset.x / width })

  const go = (p: Page) => { setPage(p); pager.current?.scrollTo({ x: PAGES.indexOf(p) * width, animated: true }) }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, gap: 12, paddingBottom: 8 }}>
        <View style={{ height: 44, justifyContent: 'center' }}>
          <Logo scale={1.2} />
        </View>
        <SearchField value={query} onChangeText={setQuery} placeholder={page === 'inbox' ? 'Search chats' : 'Search your crew'} />
        <Segment
          value={page}
          onChange={go}
          progress={progress}
          accessibilityLabel="Show chats or your crew"
          options={[
            { value: 'inbox', label: 'Inbox', count: ws.threads.filter(isUnread).length || undefined },
            { value: 'crew', label: 'Crew', count: ws.teammates.length || undefined },
          ]}
        />
      </View>
      <Animated.ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => setPage(PAGES[Math.round(e.nativeEvent.contentOffset.x / width)] ?? 'inbox')}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
      >
        <View style={{ width }}><Inbox query={query} /></View>
        <View style={{ width }}><CrewList query={query} /></View>
      </Animated.ScrollView>
      {ws.teammates.length > 0 && (
        <FabMenu
          accessibilityLabel="New chat, project or teammate"
          items={[
            { label: 'Message a teammate', icon: BubbleChatIcon, onPress: () => setPicker(true) },
            { label: 'New project', icon: UserGroupIcon, onPress: () => router.push('/project/new') },
            { label: 'New teammate', icon: UserAdd01Icon, onPress: () => router.push('/teammate/new') },
          ]}
        />
      )}
      <Sheet open={picker} onClose={() => setPicker(false)} title="Message a teammate">
        <View style={{ paddingHorizontal: 8 }}>
          {ws.teammates.map((t) => (
            <ListRow
              key={t.id}
              title={t.name}
              subtitle={t.role}
              leading={<TeammateAvatar teammate={t} size={40} interactive={false} state={ws.isWorking(t.id) ? 'working' : 'default'} />}
              onPress={() => { setPicker(false); openThread(`dm:${t.id}`) }}
            />
          ))}
        </View>
      </Sheet>
    </View>
  )
}

function Inbox({ query }: { query: string }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => { setRefreshing(true); await ws.refresh(); setRefreshing(false) }

  const q = query.trim().toLowerCase()
  const threads = [...ws.threads]
    .sort((a, b) => Date.parse(b.last_message_at ?? b.created_at) - Date.parse(a.last_message_at ?? a.created_at))
    .filter((t) => !q || `${ws.threadTitle(t.id)} ${ws.previews[t.id]?.text ?? ''}`.toLowerCase().includes(q))

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
            : <Button label="Create a teammate" icon={Add01Icon} onPress={() => router.push('/teammate/new')} />}
        />
      </View>
    )
  }

  return (
    <FlatList
      data={threads}
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
      ListFooterComponent={ws.projects.length === 0 && !q ? (
        <Press radius={16} onPress={() => router.push('/project/new')} outerStyle={{ marginHorizontal: 16, marginTop: 12 }} style={{ padding: 16, borderWidth: 1, borderColor: c.line, borderStyle: 'dashed', flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
            <Icon icon={UserGroupIcon} size={20} color="ink2" />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium">Start a project</Text>
            <Text variant="caption" color="ink3">A group chat where several teammates work together.</Text>
          </View>
        </Press>
      ) : null}
    />
  )
}

function previewText(p: Preview | undefined, thread: Thread, name: (id: string | null) => string | undefined) {
  if (!p) return thread.kind === 'dm' ? 'No messages yet' : 'No messages yet. Say hello to the team.'
  const who = p.sender_type === 'user' ? 'You: ' : thread.kind === 'project' && p.sender_type === 'teammate' && p.kind === 'text' ? `${name(p.teammate_id) ?? 'Teammate'}: ` : ''
  const body = p.kind === 'error' ? 'A run failed' : stripCues(p.text).replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim()
  return who + body
}

function ChatRow({ thread }: { thread: Thread }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const title = ws.threadTitle(thread.id)
  const p = ws.previews[thread.id]
  const unread = isUnread(thread)
  const pending = ws.pendingApprovals.filter((a) => a.thread_id === thread.id).length
  const working = ws.liveRuns.find((r) => r.thread_id === thread.id && r.status === 'running')
  const workerName = working && ws.teammate(working.teammate_id)?.name

  const sub = working
    ? `${workerName ?? 'A teammate'} is working`
    : pending
      ? `Waiting for your approval`
      : previewText(p, thread, (id) => ws.teammate(id)?.name)

  const people = ws.threadTeammates(thread.id)
  const subtitleColor = working || pending ? 'tube' : unread ? 'ink2' : 'ink3'

  return (
    <Press
      radius={16}
      static
      onPress={() => openThread(thread.id)}
      onLongPress={() => showMenu({
        title,
        items: [
          ...(unread ? [{ label: 'Mark as read', icon: CheckListIcon, onPress: () => ws.markRead(thread.id) }] : []),
          thread.kind === 'dm'
            ? { label: 'View profile', icon: Settings01Icon, onPress: () => router.push({ pathname: '/teammate/[id]', params: { id: thread.teammate_id! } }) }
            : { label: 'Project settings', icon: Settings01Icon, onPress: () => router.push({ pathname: '/project/[id]/settings', params: { id: thread.project_id! } }) },
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
  )
}
