import { useFonts } from 'expo-font'
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
import { usePushRouting } from '@/lib/push-routing'
import { useSession } from '@/lib/session'
import { WorkspaceProvider } from '@/lib/workspace'
import { ThemeProvider, useTheme } from '@/theme'
import { ConfirmHost, MenuHost, PortalHost, ToastHost } from '@/ui'

SplashScreen.preventAutoHideAsync().catch(() => {})

const OWN_EDGE = new Set(['(tabs)', 'chat/[threadId]', 'sign-in'])

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'InterDisplay-Regular': require('@/assets/fonts/InterDisplay-Regular.ttf'),
    'InterDisplay-Medium': require('@/assets/fonts/InterDisplay-Medium.ttf'),
    'InterDisplay-SemiBold': require('@/assets/fonts/InterDisplay-SemiBold.ttf'),
    'InterDisplay-Bold': require('@/assets/fonts/InterDisplay-Bold.ttf'),
  })
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            {fontsLoaded ? <Root /> : null}
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

  useEffect(() => { if (ready) SplashScreen.hideAsync().catch(() => {}) }, [ready])
  usePushRouting(signedIn)

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
              <Stack.Screen name="connections" />
              <Stack.Screen name="memory" />
            </Stack.Protected>
          </Stack>
          {signedIn && <SheetsHost />}
          <PortalHost />
          <MenuHost />
          <ConfirmHost />
          <ToastHost />
        </View>
      </WorkspaceProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </NavThemeProvider>
  )
}
