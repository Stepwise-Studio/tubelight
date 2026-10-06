import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { Add01Icon, CheckListIcon, Clock01Icon } from '@hugeicons/core-free-icons'

import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { FollowupList, FollowupSheet } from '@/components/tasks/followups'
import { TodoList } from '@/components/tasks/todo-list'
import { dueLabel, refreshTasks, useFollowups, useTodos, type Followup, type Todo, type TodoStatus } from '@/lib/tasks'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Button, EmptyState, Icon, IconButton, Reveal, Segment, Skeleton, TeammateAvatar, Text, haptic } from '@/ui'

type View_ = 'todos' | 'followups'

export default function Tasks() {
  const { c } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const { todos, error } = useTodos()
  const follow = useFollowups()
  const [view, setView] = useState<View_>('todos')
  const [fsheet, setFsheet] = useState<{ open: boolean; f: Followup | null; n: number }>({ open: false, f: null, n: 0 })
  const [refreshing, setRefreshing] = useState(false)

  // Teammates add to-dos and follow-ups from chats: catch up whenever the tab comes into view.
  useFocusEffect(useCallback(() => { refreshTasks() }, []))

  const open = (todos ?? []).filter((t) => t.status !== 'done' && t.status !== 'canceled')
  const dueToday = open.filter((t) => t.due && dueLabel(t.due).today).length
  const overdue = open.filter((t) => t.due && dueLabel(t.due).overdue).length
  const summary = [`${open.length} open`, dueToday && `${dueToday} due today`, overdue && `${overdue} overdue`].filter(Boolean).join(' · ')
  const add = (status?: TodoStatus) => { haptic.tap(); router.push({ pathname: '/todo/[id]', params: { id: 'new', ...(status ? { status } : {}) } }) }
  const sleeper = ws.teammates[0]

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: inset + 24, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshTasks(); setRefreshing(false) }}
          tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
      >
        <TabHeader title="Tasks" right={view === 'todos' && (
          <IconButton icon={Add01Icon} variant="soft" round accessibilityLabel="New to-do" onPress={() => add()} />
        )} />
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          <Segment<View_> value={view} onChange={setView} accessibilityLabel="Tasks"
            options={[{ value: 'todos', label: 'To-dos', count: open.length || undefined }, { value: 'followups', label: 'Follow-ups', count: follow.pending?.length || undefined }]} />
          {view === 'todos' && !!todos?.length && <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 4 }}>{summary}</Text>}
          {view === 'followups' && !!follow.pending?.length && (
            <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 4 }}>What your teammates will come back to. Tap one to change it.</Text>
          )}
        </View>

        {view === 'todos' ? (
          <Reveal ready={todos !== null || !!error} style={{ flexGrow: 1 }} skeleton={<Rows />}>
            {todos?.length ? (
              <TodoList todos={todos} onOpen={(todo: Todo) => router.push({ pathname: '/todo/[id]', params: { id: todo.id } })} onAdd={add} />
            ) : (
              <EmptyState
                art={<View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}><Icon icon={CheckListIcon} size={26} color="tube" /></View>}
                title={error ? 'Unable to load your to-dos' : 'A clear list'}
                body={error ?? 'Add what’s on your plate, or tell a teammate “add renewing my passport to my to-dos”.'}
                action={<Button label={error ? 'Try again' : 'Add a to-do'} onPress={() => (error ? refreshTasks() : add())} />}
              />
            )}
          </Reveal>
        ) : (
          <Reveal ready={follow.pending !== null || !!follow.error} style={{ flexGrow: 1 }} skeleton={<Rows avatar />}>
            {follow.pending?.length || follow.done.length ? (
              <FollowupList pending={follow.pending ?? []} done={follow.done} onOpen={(f) => setFsheet((s) => ({ open: true, f, n: s.n + 1 }))} />
            ) : (
              <EmptyState
                art={sleeper ? <TeammateAvatar teammate={sleeper} size={56} state="sleeping" /> : <Icon icon={Clock01Icon} size={26} color="ink3" />}
                title={follow.error ? 'Unable to load follow-ups' : 'Nothing to come back to'}
                body={follow.error ?? 'Ask a teammate “remind me at 6 to call Mom”, or “check back when the design is done”, and it shows here.'}
              />
            )}
          </Reveal>
        )}
      </ScrollView>
      <FollowupSheet key={`f${fsheet.n}`} open={fsheet.open} f={fsheet.f} onClose={() => setFsheet((s) => ({ ...s, open: false }))} />
    </View>
  )
}

function Rows({ avatar }: { avatar?: boolean }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 22, gap: 22 }} accessible accessibilityLabel="Loading">
      {[0, 1, 2, 3, 4].map((i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <Skeleton width={avatar ? 32 : 20} height={avatar ? 32 : 20} radius={16} />
          <View style={{ flex: 1, gap: 7 }}>
            <Skeleton width={`${50 + ((i * 17) % 40)}%`} height={12} />
            {avatar && <Skeleton width="35%" height={10} />}
          </View>
        </View>
      ))}
    </View>
  )
}
