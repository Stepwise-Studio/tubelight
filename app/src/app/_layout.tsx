import { EdgeScreen } from '@/components/bottom-edge'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { SheetsHost } from '@/components/sheets-host'
import { VaultSheetsHost } from '@/components/vault/actions'
import { usePushRouting } from '@/lib/push-routing'
import { useSession } from '@/lib/session'
import { registerPhone, useNotificationSync, usePhoneActions } from '@/lib/phone'
import { useThread } from '@/lib/use-thread'
import { WorkspaceProvider, isPhone, useWorkspace } from '@/lib/workspace'
import { ThemeProvider, useTheme } from '@/theme'
import { ConfirmHost, EmojiPickerHost, MenuHost, PortalHost, ToastHost } from '@/ui'

SplashScreen.preventAutoHideAsync().catch(() => {})
const hideSplash = () => { SplashScreen.hideAsync().catch(() => {}) }

const OWN_EDGE = new Set(['vault/file/[id]', 'file', 'open', 'todo/[id]', 'alarm/[id]', 'reminder/[id]', 'event/[id]', '(tabs)', 'chat/[threadId]', 'sign-in'])

// Inter Display and the other families are embedded natively by the expo-font plugin (app.json), so Android resolves
// them by name from the first frame: nothing to load, and the app no longer waits on a font pass to draw.
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            <Root />
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

function Root() {
  const { c, scheme } = useTheme()
  const { session, ready } = useSession()
  const signedIn = !!session

  // The splash stays until the saved workspace is on screen (signed in) so the inbox never flashes its skeleton; a
  // slow read can't hold it past 2.5 s.
  useEffect(() => {
    if (!ready) return
    if (!signedIn) { SplashScreen.hideAsync().catch(() => {}); return }
    const t = setTimeout(hideSplash, 2500)
    return () => clearTimeout(t)
  }, [ready, signedIn])
  usePushRouting(signedIn)
  useNotificationSync(signedIn)

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme
  const navTheme = { ...base, colors: { ...base.colors, background: c.canvas, card: c.panel, text: c.ink, border: c.line, primary: c.tube } }

  if (!ready) return <View style={{ flex: 1, backgroundColor: c.canvas }} />
  return (
    <NavThemeProvider value={navTheme}>
      <WorkspaceProvider key={session?.user.id ?? 'signed-out'} userId={session?.user.id ?? null}>
        <View style={{ flex: 1, backgroundColor: c.canvas }}>
          <Stack
            screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.canvas } }}
            // Every page's content fades and blurs under the bottom edge; tabs and chats do it under their own bars.
            screenLayout={({ children, route }) => (OWN_EDGE.has(route.name) ? children : <EdgeScreen>{children}</EdgeScreen>)}
          >
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="sign-in" options={{ animation: 'fade' }} />
            </Stack.Protected>
            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
              <Stack.Screen name="chat/[threadId]" />
              <Stack.Screen name="teammate/[id]" />
              <Stack.Screen name="project/[id]/settings" />
              <Stack.Screen name="project/[id]/repo" />
              <Stack.Screen name="connections" />
              <Stack.Screen name="memory" />
              <Stack.Screen name="automations" />
              <Stack.Screen name="crew" />
              <Stack.Screen name="automation/[id]" />
              <Stack.Screen name="usage" />
              <Stack.Screen name="computers" />
              <Stack.Screen name="scan" options={{ animation: 'fade' }} />
              <Stack.Screen name="link" />
              <Stack.Screen name="vault/[id]" />
              <Stack.Screen name="todo/[id]" options={{ animation: 'slide_from_bottom' }} />
              <Stack.Screen name="alarm/[id]" options={{ animation: 'slide_from_bottom' }} />
              <Stack.Screen name="reminder/[id]" options={{ animation: 'slide_from_bottom' }} />
              <Stack.Screen name="event/[id]" options={{ animation: 'slide_from_bottom' }} />
              <Stack.Screen name="vault/file/[id]" options={{ animation: 'fade_from_bottom' }} />
              <Stack.Screen name="file" options={{ animation: 'fade_from_bottom' }} />
              <Stack.Screen name="open" options={{ animation: 'fade' }} />
            </Stack.Protected>
          </Stack>
          {signedIn && <SplashGate />}
          {signedIn && <SheetsHost />}
          {signedIn && <VaultSheetsHost />}
          {signedIn && session && <PhoneHub userId={session.user.id} />}
          <PortalHost />
          <MenuHost />
          <EmojiPickerHost />
          <ConfirmHost />
          <ToastHost />
        </View>
      </WorkspaceProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </NavThemeProvider>
  )
}

function SplashGate() {
  const { loading } = useWorkspace()
  useEffect(() => { if (!loading) hideSplash() }, [loading])
  return null
}

/** The phone's own teammate: made the first time the app runs on a phone that can do phone actions, and the one place
 *  its replies' actions run (alarms, apps…) wherever you are in the app. Other teammates ask it (agent ask_phone). */
function PhoneHub({ userId }: { userId: string }) {
  const ws = useWorkspace()
  const mate = ws.everyone.find(isPhone)
  useEffect(() => {
    if (ws.loading || mate) return
    registerPhone().then((r) => { if (r) ws.refresh() }, () => {})
  }, [ws.loading, mate]) // eslint-disable-line react-hooks/exhaustive-deps
  return mate ? <PhoneActions threadId={`dm:${mate.id}`} userId={userId} /> : null
}

function PhoneActions({ threadId, userId }: { threadId: string; userId: string }) {
  usePhoneActions(useThread(threadId, userId).messages)
  return null
}
