// The assistant panel's own React root ("assistant", registered in index.ts): drawn by AssistActivity, a see-through
// window over whatever app is open, when Tubelight is the phone's digital assistant. Voice mode as a bottom panel,
// talking to the chosen teammate in your DM with them, with all their tools (reminders, automations, apps, computers).
import { BackHandler, Linking, Pressable, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { VoiceMode } from '@/components/voice/voice-mode'
import { useAssistantMate } from '@/lib/assistant'
import { useSession } from '@/lib/session'
import { useThread } from '@/lib/use-thread'
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace'
import { ThemeProvider, useTheme } from '@/theme'
import { Button, Surface, Text } from '@/ui'

const close = () => BackHandler.exitApp() // finishes AssistActivity, back to what was on screen

export function AssistantRoot() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            <Assistant />
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

function Assistant() {
  const { session, ready } = useSession()
  if (!ready) return null
  if (!session) {
    return (
      <Shade>
        <Surface radius={24} padding={20} style={{ margin: 16, gap: 12 }}>
          <Text variant="headline">Sign in to Tubelight first</Text>
          <Button label="Open Tubelight" onPress={() => { Linking.openURL('tubelight://'); close() }} />
        </Surface>
      </Shade>
    )
  }
  return (
    <WorkspaceProvider userId={session.user.id}>
      <Talk userId={session.user.id} />
    </WorkspaceProvider>
  )
}

function Talk({ userId }: { userId: string }) {
  const ws = useWorkspace()
  const { mate } = useAssistantMate(ws.teammates)
  const threadId = mate ? `dm:${mate.id}` : ''
  const t = useThread(threadId, userId)
  if (!mate) return ws.loading ? <Shade /> : (
    <Shade>
      <Surface radius={24} padding={20} style={{ margin: 16, gap: 12 }}>
        <Text variant="headline">Make a teammate first</Text>
        <Button label="Open Tubelight" onPress={() => { Linking.openURL('tubelight://'); close() }} />
      </Surface>
    </Shade>
  )
  const runs = ws.liveRuns.filter((r) => r.thread_id === threadId)
  return (
    <Shade>
      <VoiceMode
        variant="panel"
        teammate={mate}
        title={mate.name}
        threadId={threadId}
        messages={t.messages}
        working={runs.some((r) => r.status === 'running')}
        activity={Object.values(t.statuses).find((st) => st.label)?.label}
        onTask={(text) => t.send(text, [], { voiceTask: true })}
        onType={() => { Linking.openURL(`tubelight://chat/${encodeURIComponent(threadId)}`); close() }}
        onClose={close}
      />
    </Shade>
  )
}

/** The app underneath stays visible, dimmed; a tap above the panel closes it. */
function Shade({ children }: { children?: React.ReactNode }) {
  const { scheme } = useTheme()
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)' }]}
        onPress={close} accessibilityLabel="Close the assistant" />
      {children}
    </View>
  )
}
