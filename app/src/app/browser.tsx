// Tubelight's browser on your server (agent-service app/browser.py), live: watch a teammate work on a site, take over
// to sign in yourself (teammates never type passwords), or stop everything. Frames come over a websocket; while you
// hold it, your taps, scrolls and typing go straight to the page and teammates wait.
import { Image } from 'expo-image'
import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { ScrollView, TextInput, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowLeft01Icon, Logout01Icon, ViewIcon, ViewOffIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { BASE, api } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { radius, type as typeScale, useTheme } from '@/theme'
import { Button, Chip, IconButton, Skeleton, Squircle, Text, confirm, haptic, toast } from '@/ui'

const W = 412
const H = 915

/** The socket and the drag in progress: plain mutable state the gesture callbacks share. */
class Link {
  ws: WebSocket | null = null
  dy = 0
  send(m: Record<string, unknown>) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)) }
  /** Drags add up to one scroll per ~24pt of page. */
  drag(d: number) {
    this.dy -= d
    if (Math.abs(this.dy) > 24) { this.send({ t: 'scroll', dy: this.dy * 1.4 }); this.dy = 0 }
  }
}

interface State {
  running: boolean; sites: string[]; takeover: boolean; url: string; title: string
  /** One tab per teammate working in the browser ("you" when you opened it); `tab` is the one shown. */
  tab: string; tabs: { key: string; label: string }[]
}

export default function BrowserScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [link] = useState(() => new Link())
  const [frame, setFrame] = useState<string | null>(null)
  const [st, setSt] = useState<State | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [input, setInput] = useState('')
  const [hidden, setHidden] = useState(true)
  // Stopped from here: stay closed (reconnecting would start the browser again) until they open it.
  const [stopped, setStopped] = useState(false)

  useFocusEffect(useCallback(() => {
    if (stopped) return
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const open = async () => {
      const { data } = await supabase.auth.getSession()
      if (!alive) return
      // React Native's WebSocket takes headers as a third argument (Android/iOS), so the token never goes in the URL.
      const Socket = WebSocket as unknown as new (url: string, protocols?: string[] | null, opts?: { headers: Record<string, string> }) => WebSocket
      const sock = new Socket(`${BASE.replace(/^http/, 'ws')}/browser/live`, null, { headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` } })
      link.ws = sock
      sock.onmessage = (e) => {
        const m = JSON.parse(String(e.data))
        if (m.t === 'frame') setFrame(m.data)
        else if (m.t === 'state') { setSt(m); setProblem(null) }
        else if (m.t === 'error') setProblem(m.why)
      }
      sock.onclose = (e) => {
        if (link.ws === sock) link.ws = null
        if (e.code === 4503) { setProblem('The browser isn’t set up on your server yet.'); return }
        if (alive && e.code !== 4401) retry = setTimeout(open, 2000)
      }
    }
    open()
    return () => { alive = false; clearTimeout(retry); link.ws?.close(); link.ws = null }
  }, [link, stopped]))

  const send = (m: Record<string, unknown>) => link.send(m)
  const takeover = st?.takeover ?? false
  const scale = box.w && box.h ? Math.min(box.w / W, box.h / H) : 0

  const tap = Gesture.Tap().runOnJS(true).enabled(takeover).onEnd((e) => {
    haptic.tap()
    send({ t: 'tap', x: e.x / scale, y: e.y / scale })
  })
  const pan = Gesture.Pan().runOnJS(true).enabled(takeover).activeOffsetY([-8, 8]).onChange((e) => {
    link.drag(e.changeY / scale)
  })

  const stop = async () => {
    if (!(await confirm({ title: 'Stop the browser?', body: 'Teammates lose every site you allowed and the browser closes. Your sign-ins stay.', confirmLabel: 'Stop', destructive: true }))) return
    try { await api('/browser/stop', { method: 'POST' }); setFrame(null); setSt(null); setStopped(true); haptic.success() } catch (e) { toast({ title: 'Unable to stop it', body: (e as Error).message, tone: 'error' }) }
  }
  const signOut = async () => {
    if (!(await confirm({ title: 'Sign out of every site?', body: 'Tubelight’s browser forgets all its sign-ins. Teammates can’t use those sites until you sign in again.', confirmLabel: 'Sign out', destructive: true }))) return
    try { await api('/browser/sign-out', { method: 'POST' }); setFrame(null); setSt(null); setStopped(true); toast({ title: 'Signed out of every site' }) } catch (e) { toast({ title: 'Unable to sign out', body: (e as Error).message, tone: 'error' }) }
  }

  const sites = st?.sites ?? []
  const status = stopped ? 'Closed: no site allowed, nothing running' : problem ?? (!st ? 'Connecting…' : takeover ? 'You’re in control: teammates wait'
    : sites.length ? `Teammates may act on ${sites.join(', ')}` : 'Teammates only read pages for now')

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Browser" subtitle={!stopped && st?.url ? st.url.replace(/^https?:\/\/(www\.)?/, '') : 'On your server'}
        right={<IconButton icon={Logout01Icon} accessibilityLabel="Sign out of every site" onPress={signOut} />} />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={{ flex: 1, padding: 16, paddingBottom: 8 }}>
          {!stopped && (st?.tabs.length ?? 0) > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 10 }} contentContainerStyle={{ gap: 6 }}>
              {st!.tabs.map((t) => (
                <Chip key={t.key} label={t.label} selected={t.key === st!.tab} onPress={() => { haptic.tap(); setFrame(null); send({ t: 'tab', key: t.key }) }} />
              ))}
            </ScrollView>
          )}
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} onLayout={(e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
            {scale > 0 && (
              <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
                <Squircle style={{ width: W * scale, height: H * scale, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.panel2,
                  borderWidth: takeover ? 2 : 1, borderColor: takeover ? c.tube : c.line }}>
                  {stopped ? (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 }}>
                      <Text variant="bodyMedium" color="ink2" align="center">The browser is closed</Text>
                      <Button label="Open it" variant="soft" style={{ alignSelf: 'center' }} onPress={() => setStopped(false)} />
                    </View>
                  ) : frame ? (
                    <Image source={{ uri: `data:image/jpeg;base64,${frame}` }} style={{ flex: 1 }} contentFit="fill" transition={0}
                      cachePolicy="none" accessibilityLabel="The browser's page" />
                  ) : (
                    <View style={{ flex: 1, padding: 16, gap: 10 }}><Skeleton width="60%" /><Skeleton width="85%" /><Skeleton width="40%" /></View>
                  )}
                </Squircle>
              </GestureDetector>
            )}
          </View>
          <Text variant="footnote" color={problem ? 'danger' : 'ink3'} align="center" style={{ marginTop: 8 }} numberOfLines={2}>{status}</Text>
        </View>

        <View style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 12, gap: 10 }}>
          {takeover ? (
            <>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Chip label="Back" icon={ArrowLeft01Icon} onPress={() => send({ t: 'back' })} />
                <Chip label="Delete" onPress={() => send({ t: 'key', k: 'backspace' })} />
                <Chip label="Enter" onPress={() => send({ t: 'key', k: 'enter' })} />
                <Chip label="Tab" onPress={() => send({ t: 'key', k: 'tab' })} />
              </View>
              <Squircle style={{ borderRadius: radius.md, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', paddingLeft: 12 }}>
                <TextInput value={input} onChangeText={setInput} placeholder="Type into the page, or an address" placeholderTextColor={c.ink4}
                  secureTextEntry={hidden} autoCapitalize="none" autoCorrect={false} style={[typeScale.body, { flex: 1, color: c.ink, paddingVertical: 12 }]} />
                <IconButton icon={hidden ? ViewIcon : ViewOffIcon} accessibilityLabel={hidden ? 'Show what you type' : 'Hide what you type'} onPress={() => setHidden((h) => !h)} />
              </Squircle>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Type" variant="soft" style={{ flex: 1 }} fullWidth disabled={!input} onPress={() => { send({ t: 'text', v: input }); setInput('') }} />
                <Button label="Open address" variant="soft" style={{ flex: 1 }} fullWidth disabled={!input || input.includes(' ')} onPress={() => { send({ t: 'go', url: input.trim() }); setInput('') }} />
              </View>
              <Button label="Done: give it back" fullWidth onPress={() => { send({ t: 'takeover', on: false }); setHidden(true) }} />
            </>
          ) : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="Take over" style={{ flex: 1 }} fullWidth disabled={!st || !!problem || stopped} onPress={() => { haptic.tap(); send({ t: 'takeover', on: true }) }} />
              <Button label="Stop" variant="outline" style={{ flex: 1 }} fullWidth disabled={!st || stopped} onPress={stop} />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}
