import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'

import { ApprovalCard } from '@/components/approval-card'
import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { supabase } from '@/lib/supabase'
import type { Approval } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { EmptyState, Icon, Press, Reveal, Segment, Skeleton, TeammateAvatar, Text } from '@/ui'

type Tab = 'pending' | 'history'

export default function Approvals() {
  const { c } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const [tab, setTab] = useState<Tab>('pending')
  const [history, setHistory] = useState<Approval[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadHistory = () => supabase.from('approvals').select('*').neq('status', 'pending').eq('kind', 'approval')
    .order('decided_at', { ascending: false, nullsFirst: false }).limit(50)
    .then(({ data }) => setHistory((data as Approval[]) ?? []))
  // Decisions move cards from Pending to History; refetch when the pending set changes.
  const pendingIds = ws.pendingApprovals.map((a) => a.id).join()
  useEffect(() => { if (tab === 'history') loadHistory() }, [tab, pendingIds])

  const refresh = async () => {
    setRefreshing(true)
    await Promise.all([ws.refresh(), tab === 'history' ? loadHistory() : null])
    setRefreshing(false)
  }

  const data = tab === 'pending' ? ws.pendingApprovals : history ?? []
  const ready = tab === 'pending' ? !ws.loading : history !== null
  const sleeper = ws.teammates[0]

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={ready ? data : []}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ paddingBottom: inset + 16, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
        ListHeaderComponent={
          <>
            <TabHeader title="Approvals" />
            <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
              <Segment<Tab>
                value={tab}
                onChange={setTab}
                accessibilityLabel="Approvals"
                options={[{ value: 'pending', label: 'Pending', count: ws.pendingApprovals.length }, { value: 'history', label: 'History' }]}
              />
            </View>
          </>
        }
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item }) => <Row approval={item} />}
        ListEmptyComponent={
          <Reveal
            ready={ready}
            style={{ flex: 1, justifyContent: 'center' }}
            skeleton={<View style={{ padding: 16, gap: 12 }}>{[0, 1].map((i) => <Skeleton key={i} height={160} radius={16} />)}</View>}
          >
            {tab === 'pending' ? (
              <EmptyState
                title="Nothing waiting for you"
                body="When a teammate wants to send an email, post or push code, the request waits here until you approve it."
                art={sleeper ? <TeammateAvatar teammate={sleeper} size={56} state="sleeping" /> : undefined}
              />
            ) : (
              <EmptyState title="No decisions yet" body="Requests you approve or reject show up here." />
            )}
          </Reveal>
        }
      />
    </View>
  )
}

function Row({ approval }: { approval: Approval }) {
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
