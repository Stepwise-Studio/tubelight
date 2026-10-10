// The assistant panel's own React root ("assistant", registered in index.ts): drawn by AssistActivity, a see-through
// window over whatever app is open (or the lock screen), when Tubelight is the phone's digital assistant. Voice mode
// as a bottom sheet with the phone's own teammate (agent phone.py), who also sees what was on screen when summoned. Opened by a
// "needs you" alert instead (modules/phone `ring`), it goes to that chat with the decision on top.
import { useEffect, useMemo, useState } from 'react'
import { Blur, Canvas, Image as SkImage, LinearGradient, Mask, Rect, Skia, vec } from '@shopify/react-native-skia'
import { BackHandler, Linking, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
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
import { ThemeProvider, motion, useTheme } from '@/theme'
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
    <Shade image={screen?.image}>
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

/**
 * The app underneath, softened. Samsung keeps Android's cross-window blur to itself (`mBlurEnabled=false`), so the
 * blur is drawn here from the screenshot the system hands the assistant: lightly blurred at the top, melting into a
 * heavy blur through the lower 80% where the conversation sits, then dimmed the same way. Without a screenshot (opened
 * from an alert, or screenshots off in the assistant settings) the dim alone carries it. A tap above it closes.
 */
function Shade({ children, image }: { children?: React.ReactNode; image?: string | null }) {
  const { scheme } = useTheme()
  const { width, height } = useWindowDimensions()
  const shot = useMemo(() => (image ? Skia.Image.MakeImageFromEncoded(Skia.Data.fromBase64(image)) : null), [image])
  const tint = scheme === 'dark' ? '0,0,0' : '250,250,250'
  const dim = shot ? [0.1, 0.2, 0.5, 0.66, 0.74] : [0.18, 0.3, 0.7, 0.86, 0.92]
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      {shot && (
        <Animated.View entering={FadeIn.duration(motion.duration.slow)} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Canvas style={{ width, height }}>
            <SkImage image={shot} x={0} y={0} width={width} height={height} fit="cover"><Blur blur={4} mode="clamp" /></SkImage>
            <Mask mask={<Rect x={0} y={0} width={width} height={height}>
              <LinearGradient start={vec(0, height * 0.06)} end={vec(0, height * 0.3)} colors={['rgba(0,0,0,0)', 'rgba(0,0,0,1)']} />
            </Rect>}>
              <SkImage image={shot} x={0} y={0} width={width} height={height} fit="cover"><Blur blur={26} mode="clamp" /></SkImage>
            </Mask>
          </Canvas>
        </Animated.View>
      )}
      <Animated.View entering={FadeIn.duration(motion.duration.slow)} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Canvas style={{ width, height }}>
          <Rect x={0} y={0} width={width} height={height}>
            <LinearGradient start={vec(0, 0)} end={vec(0, height)} positions={[0, 0.16, 0.34, 0.65, 1]}
              colors={dim.map((a) => `rgba(${tint},${a})`)} />
          </Rect>
        </Canvas>
      </Animated.View>
      <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close the assistant" />
      {children}
    </View>
  )
}
