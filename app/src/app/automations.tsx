// Automations: everything teammates do on their own, grouped by the chat it posts in. Set up by chatting with a
// teammate ("every morning at 8, brief me on new mail") or with New; each opens /automation/[id].
import { router } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon, RepeatIcon } from '@hugeicons/core-free-icons'

import { AutomationRows } from '@/components/automation-rows'
import { ScreenHeader } from '@/components/screen-header'
import { ThreadAvatar } from '@/components/thread-avatar'
import { useAutomations, type Automation } from '@/lib/automations'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Button, EmptyState, Icon, IconButton, Press, Skeleton, Surface, Text } from '@/ui'

const newAutomation = () => router.push({ pathname: '/automation/[id]', params: { id: 'new' } })

export default function AutomationsScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const ws = useWorkspace()
  const { list, toggle } = useAutomations()

  // One card per chat, the chat with the newest automation first (the list comes newest first).
  const groups: [string, Automation[]][] = []
  for (const a of list ?? []) {
    const g = groups.find(([t]) => t === a.thread_id)
    if (g) g[1].push(a)
    else groups.push([a.thread_id, [a]])
  }
  const on = (list ?? []).filter((a) => a.enabled).length

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader
        title="Automations"
        subtitle={list?.length ? `${on} on${list.length > on ? ` · ${list.length - on} paused` : ''}` : 'What teammates do on their own'}
        right={<IconButton icon={Add01Icon} accessibilityLabel="New automation" onPress={newAutomation} />}
      />
      {list === null ? (
        <View style={{ padding: 20, gap: 12 }}>
          <Skeleton width={120} height={12} />
          <Surface padding={16} style={{ gap: 10 }}><Skeleton width="70%" /><Skeleton width="45%" /></Surface>
        </View>
      ) : list.length === 0 ? (
        <EmptyState
          art={<View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}><Icon icon={RepeatIcon} size={28} color="tube" /></View>}
          title="Nothing runs on its own yet"
          body="Ask a teammate in any chat, like “every morning at 8, brief me on new mail” or “whenever a mail from Priya arrives, ping me”."
          action={<Button label="New automation" icon={Add01Icon} variant="soft" onPress={newAutomation} />}
        />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: insets.bottom + 40, gap: 28 }}>
          {groups.map(([threadId, items]) => (
            <View key={threadId} style={{ gap: 10 }}>
              <Press
                radius={10}
                static
                onPress={() => router.push({ pathname: '/chat/[threadId]', params: { threadId } })}
                accessibilityLabel={`Open ${ws.threadTitle(threadId)}`}
                outerStyle={{ alignSelf: 'flex-start' }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2, paddingRight: 6 }}
              >
                <ThreadAvatar threadId={threadId} size={22} />
                <Text variant="label" color="ink2" numberOfLines={1}>{ws.threadTitle(threadId)}</Text>
              </Press>
              <AutomationRows items={items} show="who" onToggle={toggle} />
            </View>
          ))}
          <Text variant="caption" color="ink3" align="center" style={{ paddingHorizontal: 12 }}>
            Tell a teammate in chat to set one up, change it or stop it. Runs with nothing new stay quiet.
          </Text>
        </ScrollView>
      )}
    </View>
  )
}
