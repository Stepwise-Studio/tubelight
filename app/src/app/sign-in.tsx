import { useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { supabase } from '@/lib/supabase'
import { motion, useTheme } from '@/theme'
import { Button, Logo, Press, Rise, Text, TextField, haptic } from '@/ui'

type Mode = 'sign-in' | 'create'

function humanError(message: string, mode: Mode) {
  const m = message.toLowerCase()
  if (m.includes('invalid login')) return 'Email or password is wrong. Check both and try again.'
  if (m.includes('already registered')) return 'That email already has an account. Sign in instead.'
  if (m.includes('password')) return 'Use a password with at least 8 characters.'
  if (m.includes('email')) return 'Enter a valid email address, like name@example.com.'
  if (m.includes('fetch') || m.includes('network')) return 'Unable to reach the server. Check your connection and try again.'
  return mode === 'create' ? 'Unable to create your account. Try again in a moment.' : 'Unable to sign in. Try again in a moment.'
}

export default function SignIn() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [mode, setMode] = useState<Mode>('sign-in')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'name' | 'email' | 'password'; text: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const emailRef = useRef<TextInput>(null)
  const passwordRef = useRef<TextInput>(null)

  const submit = async () => {
    setNotice(null)
    if (mode === 'create' && !name.trim()) return setError({ field: 'name', text: 'Enter the name your teammates will call you.' })
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError({ field: 'email', text: 'Enter a valid email address, like name@example.com.' })
    if (password.length < (mode === 'create' ? 8 : 1)) {
      return setError({ field: 'password', text: mode === 'create' ? 'Use a password with at least 8 characters.' : 'Enter your password.' })
    }
    setError(null)
    setBusy(true)
    const res = mode === 'sign-in'
      ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
      : await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim() } } })
    setBusy(false)
    if (res.error) {
      const text = humanError(res.error.message, mode)
      return setError({ field: text.includes('mail') && !text.includes('password') ? 'email' : 'password', text })
    }
    haptic.success()
    if (mode === 'create' && !res.data.session) setNotice(`Check ${email.trim()} for a confirmation link, then sign in.`)
  }

  const switchMode = () => {
    haptic.tap()
    setError(null)
    setNotice(null)
    setMode((m) => (m === 'sign-in' ? 'create' : 'sign-in'))
  }

  const errFor = (f: 'name' | 'email' | 'password') => (error?.field === f ? error.text : null)

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }}
      >
        <View style={{ width: '100%', maxWidth: 400, alignSelf: 'center' }}>
          <View style={{ marginBottom: 40 }}><Logo flicker scale={1.25} /></View>
          <Rise index={0}>
            <Text variant="title" accessibilityRole="header">{mode === 'sign-in' ? 'Sign in' : 'Create your account'}</Text>
          </Rise>
          <Rise index={1}>
            <Text variant="body" color="ink3" style={{ marginTop: 6, marginBottom: 28 }}>
              {mode === 'sign-in' ? 'Your teammates are where you left them.' : 'You’ll set up your first teammate next.'}
            </Text>
          </Rise>

          <Animated.View layout={LinearTransition.duration(motion.duration.fast)} style={{ gap: 16 }}>
            {mode === 'create' && (
              <Animated.View entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
                <TextField
                  label="Your name"
                  placeholder="Akhil"
                  value={name}
                  onChangeText={(t) => { setName(t); if (error?.field === 'name') setError(null) }}
                  error={errFor('name')}
                  autoComplete="name"
                  textContentType="name"
                  returnKeyType="next"
                  onSubmitEditing={() => emailRef.current?.focus()}
                />
              </Animated.View>
            )}
            <TextField
              inputRef={emailRef}
              label="Email"
              placeholder="name@example.com"
              value={email}
              onChangeText={(t) => { setEmail(t); if (error?.field === 'email') setError(null) }}
              error={errFor('email')}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
            <TextField
              inputRef={passwordRef}
              label="Password"
              placeholder={mode === 'create' ? 'At least 8 characters' : undefined}
              value={password}
              onChangeText={(t) => { setPassword(t); if (error?.field === 'password') setError(null) }}
              error={errFor('password')}
              secureTextEntry
              autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
              textContentType={mode === 'create' ? 'newPassword' : 'password'}
              returnKeyType="go"
              onSubmitEditing={submit}
            />
            {notice && (
              <Animated.View entering={FadeIn.duration(motion.duration.fast)}>
                <Text variant="caption" color="ink2" accessibilityLiveRegion="polite">{notice}</Text>
              </Animated.View>
            )}
            <Button
              label={mode === 'sign-in' ? 'Sign in' : 'Create account'}
              size="lg"
              fullWidth
              loading={busy}
              onPress={submit}
              style={{ marginTop: 8 }}
            />
          </Animated.View>

          <Press radius={12} static onPress={switchMode} outerStyle={{ alignSelf: 'center', marginTop: 20 }} style={{ paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' }}>
            <Text variant="label" color="ink2">
              {mode === 'sign-in' ? 'New to Tubelight? ' : 'Already have an account? '}
              <Text variant="label" color="tube">{mode === 'sign-in' ? 'Create an account' : 'Sign in'}</Text>
            </Text>
          </Press>
        </View>
      </KeyboardAwareScrollView>
    </View>
  )
}
