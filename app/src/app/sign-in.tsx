// Sign in: Google only. Everything (chats, teammates, memory, to-dos, vault) belongs to the account, so the same
// Google account on any phone brings it all back.
import { useState } from 'react'
import { View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Path } from 'react-native-svg'

import { google } from '@/lib/auth'
import { motion, useTheme } from '@/theme'
import { Logo, Press, Rise, Text, haptic } from '@/ui'

export default function SignIn() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [notice, setNotice] = useState<string | null>(null)
  const [googling, setGoogling] = useState(false)
  const withGoogle = async () => {
    haptic.tap()
    setGoogling(true)
    setNotice(null)
    try {
      await google()
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setGoogling(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas, justifyContent: 'center', paddingHorizontal: 24, paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }}>
      <View style={{ width: '100%', maxWidth: 400, alignSelf: 'center' }}>
        <View style={{ marginBottom: 40 }}><Logo flicker scale={1.25} /></View>
        <Rise index={0}>
          <Text variant="title" accessibilityRole="header">Sign in</Text>
        </Rise>
        <Rise index={1}>
          <Text variant="body" color="ink3" style={{ marginTop: 6, marginBottom: 28 }}>Your teammates are where you left them.</Text>
        </Rise>
        <Press radius={16} onPress={withGoogle} disabled={googling} accessibilityLabel="Continue with Google"
          style={{ height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 1, borderColor: c.edge, backgroundColor: c.panel }}>
          <GoogleMark />
          <Text variant="bodyMedium">{googling ? 'Opening Google…' : 'Continue with Google'}</Text>
        </Press>
        {notice && (
          <Animated.View entering={FadeIn.duration(motion.duration.fast)} style={{ marginTop: 14 }}>
            <Text variant="caption" color="ink2" accessibilityLiveRegion="polite">{notice}</Text>
          </Animated.View>
        )}
      </View>
    </View>
  )
}

/** Google's "G", in its own colours (their sign-in button guidelines). */
function GoogleMark() {
  return (
    <Svg width={20} height={20} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.1 24.6c0-1.6-.2-3.2-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.4-4.7 7.1l7.6 5.9c4.4-4.1 6.8-10.1 6.8-17.4z" />
      <Path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z" />
      <Path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </Svg>
  )
}
