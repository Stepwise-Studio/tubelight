// The assistant panel's own React root ("assistant", registered in index.ts): drawn by AssistActivity, a see-through
// window over whatever app is open (or the lock screen), when Tubelight is the phone's digital assistant. Voice mode
// as a bottom sheet with the phone's own teammate (agent phone.py), who also sees what was on screen when summoned. Opened by a
// "needs you" alert instead (modules/phone `ring`), it goes to that chat with the decision on top.
import { useEffect, useState } from 'react'
import { BackHandler, Linking, Pressable, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { ApprovalCard } from '@/components/approval-card'
import { QuestionCard } from '@/components/chat/prompt-cards'
import { VoiceMode } from '@/components/voice/voice-mode'
import { Phone, registerPhone, syncNotifications, usePhoneActions } from '@/lib/phone'
import { useSession } from '@/lib/session'
import { useThread } from '@/lib/use-thread'
import { WorkspaceProvider, isPhone, useWorkspace } from '@/lib/workspace'
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
  if (!session) return <Note title="Sign in to Tubelight first" />
  return (
    <WorkspaceProvider userId={session.user.id}>
      <Talk userId={session.user.id} />
    </WorkspaceProvider>
  )
}

type Screen = { app: string | null; text: string | null; image: string | null }

function Talk({ userId }: { userId: string }) {
  const ws = useWorkspace()
  const mate = ws.everyone.find(isPhone)
  // Why it opened: a "needs you" alert names its chat; summoned by hand, it's the phone's own chat.
  const [args] = useState(() => Phone?.launchArgs() ?? {})
  const threadId = args.thread || (mate ? `dm:${mate.id}` : '')
  const t = useThread(threadId, userId)
  usePhoneActions(t.messages)
  // What was on screen arrives just after the panel opens (if the assistant settings allow it): wait for it briefly.
  const [screen, setScreen] = useState<Screen | null | undefined>(args.thread ? null : undefined)
  useEffect(() => {
    if (!ws.loading && !mate) registerPhone().then((r) => { if (r) ws.refresh() }, () => {})
  }, [ws.loading, mate]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    Phone?.clearRing()
    syncNotifications().catch(() => {})
    if (screen !== undefined) return
    let tries = 0
    const poll = setInterval(() => {
      const got = Phone?.screenContext() ?? null
      if (got || ++tries >= 8) { clearInterval(poll); setScreen(got) }
    }, 250)
    return () => clearInterval(poll)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const speaker = args.thread ? ws.threadTeammates(threadId)[0] : mate
  if (!speaker) return <Shade />
  if (screen === undefined) return <Shade />
  const runs = ws.liveRuns.filter((r) => r.thread_id === threadId)
  const waiting = t.messages.find((m) => (m.kind === 'approval' || m.kind === 'question') && m.meta?.approval_id
    && t.approvals[m.meta.approval_id]?.status === 'pending')
  const approval = waiting?.meta?.approval_id ? t.approvals[waiting.meta.approval_id] : undefined
  return (
    <Shade>
      {approval && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 10 }}>
          {waiting?.kind === 'question' ? <QuestionCard approval={approval} /> : <ApprovalCard approval={approval} teammate={speaker} beam />}
        </View>
      )}
      <VoiceMode
        teammate={speaker}
        title={args.thread ? ws.threadTitle(threadId) : speaker.name}
        threadId={threadId}
        messages={t.messages}
        working={runs.some((r) => r.status === 'running')}
        activity={Object.values(t.statuses).find((st) => st.label)?.label}
        screen={screen}
        onTask={(text) => t.send(text, [], { voiceTask: true })}
        onClose={close}
      />
    </Shade>
  )
}

function Note({ title }: { title: string }) {
  return (
    <Shade>
      <Surface radius={24} padding={20} style={{ margin: 16, gap: 12 }}>
        <Text variant="headline">{title}</Text>
        <Button label="Open Tubelight" onPress={() => { Linking.openURL('tubelight://'); close() }} />
      </Surface>
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
