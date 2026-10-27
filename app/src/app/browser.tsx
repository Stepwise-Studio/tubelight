// Tubelight's browser on your server (agent-service app/browser.py), live: watch a teammate work on a site, take over
// to sign in yourself (teammates never type passwords), or stop everything. Frames come over a websocket; while you
// hold it, your taps, scrolls and typing go straight to the page and teammates wait. Tapping a field on the page
// focuses a native field here, so the phone's own keyboard (and password manager) types into the page as you type.
// Opened from a Sign in card (`?signin=<approval>&tab=<teammate>&site=`): that teammate's tab, already in your hands,
// and "I'm signed in" hands it back and lets the teammate carry on.
import { Image } from 'expo-image'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TextInput, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowLeft01Icon, Cancel01Icon, Key01Icon, Logout01Icon, SquareLock02Icon, ViewIcon, ViewOffIcon } from '@hugeicons/core-free-icons'

import { AgentCursor, type Cursor } from '@/components/agent-cursor'
import { ScreenHeader } from '@/components/screen-header'
import { BASE, api } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { useWorkspace } from '@/lib/workspace'
import { radius, type as typeScale, useTheme } from '@/theme'
import { Button, Chip, Icon, IconButton, Segment, Skeleton, Squircle, Text, confirm, haptic, toast } from '@/ui'

const W = 412
const H = 915

/** The socket and the drag in progress: plain mutable state the gesture callbacks share. */
class Link {
  ws: WebSocket | null = null
  tab = '' // the tab shown: cursor moves from other tabs are ignored
  dy = 0
  started = false // a Sign in card's tab has been taken over
  typed = '' // what's been sent into the focused page field (fast typing outruns React's state)
  forget() { this.typed = '' }
  mate = '' // the Sign in card's teammate, for its tab's label
  label(name: string) { this.mate = name }
  send(m: Record<string, unknown>) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)) }
  /** Live typing into the focused page field: send what changed since the last keystroke (backspaces, then new text). */
  type(next: string) {
    let same = 0
    while (same < this.typed.length && same < next.length && this.typed[same] === next[same]) same++
    if (this.typed.length > same) this.send({ t: 'key', k: 'backspace', n: this.typed.length - same })
    if (next.length > same) this.send({ t: 'text', v: next.slice(same) })
    this.typed = next
  }
  /** Drags add up to one scroll per ~24pt of page. */
  drag(d: number) {
    this.dy -= d
    if (Math.abs(this.dy) > 24) { this.send({ t: 'scroll', dy: this.dy * 1.4 }); this.dy = 0 }
  }
}

/** The page field a tap focused, and how the phone's keyboard should treat it. */
interface Focus { kind: 'password' | 'otp' | 'email' | 'username' | 'tel' | 'text'; label: string; /** its centre on the page's screen */ y: number }
const KEYBOARD: Record<Focus['kind'], { autoComplete: 'password' | 'sms-otp' | 'email' | 'username' | 'tel' | 'off'; keyboardType: 'default' | 'email-address' | 'number-pad' | 'phone-pad' }> = {
  password: { autoComplete: 'password', keyboardType: 'default' }, otp: { autoComplete: 'sms-otp', keyboardType: 'number-pad' },
  email: { autoComplete: 'email', keyboardType: 'email-address' }, username: { autoComplete: 'username', keyboardType: 'email-address' },
  tel: { autoComplete: 'tel', keyboardType: 'phone-pad' }, text: { autoComplete: 'off', keyboardType: 'default' },
}

interface State {
  running: boolean; sites: string[]; takeover: boolean; url: string; title: string
  /** One tab per teammate working in the browser ("you" when you opened it); `tab` is the one shown. */
  tab: string; tabs: { key: string; label: string }[]
  cursor: Cursor | null
}

export default function BrowserScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [link] = useState(() => new Link())
  const [frame, setFrame] = useState<string | null>(null)
  const [st, setSt] = useState<State | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [input, setInput] = useState('') // what's in the native field: typed into the page, or an address to open
  const [hidden, setHidden] = useState(true)
  const [focus, setFocus] = useState<Focus | null>(null)
  const field = useRef<TextInput>(null)
  const { signin, tab: signinTab, site } = useLocalSearchParams<{ signin?: string; tab?: string; site?: string }>()
  // Stopped from here: stay closed (reconnecting would start the browser again) until they open it.
  const [stopped, setStopped] = useState(false)
  const [cursor, setCursor] = useState<Cursor | null>(null)
  const { everyone } = useWorkspace()
  const mate = everyone.find((t) => t.id === st?.tab)
  useEffect(() => { link.label(everyone.find((t) => t.id === signinTab)?.name ?? '') }, [everyone, signinTab, link])

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
        else if (m.t === 'cursor') { if (m.key === link.tab) setCursor(m) }
        else if (m.t === 'state') {
          link.tab = m.tab; setSt(m); setCursor(m.cursor); setProblem(null)
          if (signin && !link.started) { // from a Sign in card: that teammate's tab, in their hands
            link.started = true
            link.send({ t: 'signin', key: signinTab, site, label: link.mate })
          }
        } else if (m.t === 'focus') {
          setInput(''); link.forget()
          if (m.kind === 'none') { setFocus(null); field.current?.blur() } else { setFocus(m); setHidden(true); field.current?.focus() }
        }
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
  }, [link, stopped, signin, signinTab, site]))

  const send = (m: Record<string, unknown>) => link.send(m)
  const takeover = st?.takeover ?? false
  const fit = box.w && box.h ? Math.min(box.w / W, box.h / H) : 0
  // Typing into a field with the keyboard up leaves little room: fill the width and centre on the field, instead of
  // shrinking the whole page to a thumbnail.
  const zoomed = !!focus && takeover && box.h < H * (box.w / W)
  const scale = zoomed ? box.w / W : fit
  const shift = zoomed ? Math.min(0, Math.max(box.h - H * scale, box.h / 2 - focus!.y * scale)) : 0

  const tap = Gesture.Tap().runOnJS(true).enabled(takeover).onEnd((e) => {
    haptic.tap()
    send({ t: 'tap', x: e.x / scale, y: (e.y - shift) / scale })
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

  // Typing into a page field: send what changed since the last keystroke (backspaces, then the new text).
  const typeLive = (next: string) => { link.type(next); setInput(next) }
  // Signed in by hand: offer to keep that password, so a teammate can sign them back in later (the server fills it).
  const offerSave = async (tab?: string) => {
    if (!tab) return
    try {
      const got = await api<{ site: string; username?: string }>(`/browser/passwords/captured?tab=${encodeURIComponent(tab)}`)
      if (!got.site) return
      if (!(await confirm({ title: `Save your ${got.site} password?`, confirmLabel: 'Save',
        body: `Teammates can then sign you back in${got.username ? ` as ${got.username}` : ''} when ${got.site} logs you out. It’s kept encrypted on your server and they never see it.` }))) return
      await api('/browser/passwords', { method: 'POST', json: { tab } })
      toast({ title: 'Password saved' })
    } catch { /* nothing to save, or offline: they can sign in again next time */ }
  }
  const giveBack = () => { send({ t: 'takeover', on: false }); setFocus(null); setInput(''); link.forget(); setHidden(true); offerSave(signin ? undefined : st?.tab) }
  const signedIn = async () => {
    try {
      await api(`/approvals/${signin}`, { method: 'POST', json: { action: 'signed_in' } })
      giveBack(); haptic.success(); router.back(); offerSave(signinTab)
    } catch (e) { toast({ title: 'Unable to hand it back', body: (e as Error).message, tone: 'error' }) }
  }

  if (signin) {
    // Signing in (or up) is typing-heavy: the page gets the whole screen, edge to edge, under one thin bar (✕, the
    // site, Done). Tap a field on the page and the keyboard types straight into it, through an invisible native field
    // (so the phone's keyboard, autofill and password manager work); the view keeps that field in sight.
    const k = focus ? KEYBOARD[focus.kind] : KEYBOARD.text
    const z = box.w / W
    const lift = focus && box.h ? Math.min(0, Math.max(box.h - H * z, box.h / 2 - focus.y * z)) : 0
    const tapIn = Gesture.Tap().runOnJS(true).enabled(takeover).onEnd((e) => { send({ t: 'tap', x: e.x / z, y: (e.y - lift) / z }) })
    const scrollIn = Gesture.Pan().runOnJS(true).enabled(takeover).activeOffsetY([-8, 8]).onChange((e) => { link.drag(e.changeY / z) })
    return (
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <View style={{ paddingTop: insets.top, height: insets.top + 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
          <IconButton icon={Cancel01Icon} accessibilityLabel="Cancel" color="ink" onPress={() => { giveBack(); router.back() }} />
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
            <Icon icon={SquareLock02Icon} size={13} color="ink3" />
            <Text variant="bodyMedium" numberOfLines={1}>{site}</Text>
          </View>
          <Button label="Done" size="sm" variant="soft" onPress={signedIn} style={{ alignSelf: 'center', marginRight: 6 }} />
        </View>
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          <View style={{ flex: 1, overflow: 'hidden', backgroundColor: '#ffffff' }} onLayout={(e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
            {z > 0 && (
              <GestureDetector gesture={Gesture.Exclusive(scrollIn, tapIn)}>
                <View style={{ flex: 1 }}>
                  {frame ? (
                    <Image source={{ uri: `data:image/jpeg;base64,${frame}` }} style={{ position: 'absolute', left: 0, top: lift, width: W * z, height: H * z }}
                      contentFit="fill" transition={0} cachePolicy="none" accessibilityLabel={`${site}'s sign-in page`} />
                  ) : (
                    <View style={{ padding: 20, gap: 12 }}><Skeleton width="50%" /><Skeleton width="80%" /><Skeleton width="65%" /></View>
                  )}
                </View>
              </GestureDetector>
            )}
          </View>
          <TextInput ref={field} value={input} onChangeText={typeLive} secureTextEntry={focus?.kind === 'password'}
            autoCapitalize="none" autoCorrect={false} autoComplete={k.autoComplete} keyboardType={k.keyboardType}
            importantForAutofill="yes" submitBehavior="submit" returnKeyType="next" caretHidden
            onKeyPress={(e) => { if (e.nativeEvent.key === 'Backspace' && !input) send({ t: 'key', k: 'backspace' }) }}
            onSubmitEditing={() => { send({ t: 'key', k: 'enter' }); setInput(''); link.forget() }}
            style={{ position: 'absolute', bottom: 0, left: 0, width: 1, height: 1, opacity: 0 }} />
        </KeyboardAvoidingView>
      </View>
    )
  }

  const sites = st?.sites ?? []
  const status = stopped ? 'Closed: no site allowed, nothing running' : problem ?? (!st ? 'Connecting…' : takeover ? 'You’re in control: teammates wait'
    : sites.length ? `Teammates may act on ${sites.join(', ')}` : 'Teammates only read pages for now')

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title={signin ? `Sign in to ${site}` : 'Browser'}
        subtitle={signin ? `Type on the page itself: ${mate?.name ?? 'your teammate'} never sees your password` : !stopped && st?.url ? st.url.replace(/^https?:\/\/(www\.)?/, '') : 'On your server'}
        right={<View style={{ flexDirection: 'row' }}>
          <IconButton icon={Key01Icon} accessibilityLabel="Saved passwords" onPress={() => router.push('/passwords')} />
          <IconButton icon={Logout01Icon} accessibilityLabel="Sign out of every site" onPress={signOut} />
        </View>} />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={{ flex: 1, padding: 16, paddingBottom: 8 }}>
          {!stopped && !signin && (st?.tabs.length ?? 0) > 1 && (
            <View style={{ marginBottom: 10 }}>
              <Segment value={st!.tab} accessibilityLabel="Whose tab"
                options={st!.tabs.map((t) => ({ value: t.key, label: t.label }))}
                onChange={(key) => { haptic.tap(); setFrame(null); send({ t: 'tab', key }) }} />
            </View>
          )}
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} onLayout={(e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
            {scale > 0 && (
              <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
                <Squircle style={{ width: W * scale, height: zoomed ? box.h : H * scale, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.panel2,
                  borderWidth: takeover ? 2 : 1, borderColor: takeover ? c.tube : c.line }}>
                  {stopped ? (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 }}>
                      <Text variant="bodyMedium" color="ink2" align="center">The browser is closed</Text>
                      <Button label="Open it" variant="soft" style={{ alignSelf: 'center' }} onPress={() => setStopped(false)} />
                    </View>
                  ) : frame ? (
                    <Image source={{ uri: `data:image/jpeg;base64,${frame}` }} style={{ position: 'absolute', left: 0, top: shift, width: W * scale, height: H * scale }} contentFit="fill" transition={0}
                      cachePolicy="none" accessibilityLabel="The browser's page" />
                  ) : (
                    <View style={{ flex: 1, padding: 16, gap: 10 }}><Skeleton width="60%" /><Skeleton width="85%" /><Skeleton width="40%" /></View>
                  )}
                  {cursor && mate && !takeover && !stopped && frame && (
                    <AgentCursor cursor={cursor} scale={scale} name={mate.name} color={mate.color || c.tube} />
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
              {/* One native field: while a page field is focused it types into it live; otherwise it opens an address. */}
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 }}>
                  {focus?.kind === 'password' && <Icon icon={SquareLock02Icon} size={14} color="ink3" />}
                  <Text variant="footnote" color="ink3" numberOfLines={1}>
                    {focus ? `Typing into ${focus.label || (focus.kind === 'password' ? 'the password' : 'the page')}` : 'Tap a field on the page to type into it'}
                  </Text>
                </View>
                <Squircle style={{ borderRadius: radius.md, backgroundColor: c.panel, borderWidth: 1, borderColor: focus ? c.tube : c.line, flexDirection: 'row', alignItems: 'center', paddingLeft: 12 }}>
                  <TextInput ref={field} value={input} onChangeText={focus ? typeLive : setInput}
                    placeholder={focus ? (focus.kind === 'password' ? 'Password' : focus.label || 'Type') : 'Or open an address'} placeholderTextColor={c.ink4}
                    secureTextEntry={focus?.kind === 'password' && hidden} autoCapitalize="none" autoCorrect={false}
                    autoComplete={focus ? KEYBOARD[focus.kind].autoComplete : 'off'} keyboardType={focus ? KEYBOARD[focus.kind].keyboardType : 'url'}
                    importantForAutofill={focus ? 'yes' : 'no'} submitBehavior="submit" returnKeyType={focus ? 'next' : 'go'}
                    onSubmitEditing={() => { if (focus) { send({ t: 'key', k: 'enter' }); setInput(''); link.forget() } else if (input.trim()) { send({ t: 'go', url: input.trim() }); setInput('') } }}
                    style={[typeScale.body, { flex: 1, color: c.ink, paddingVertical: 12 }]} />
                  {focus?.kind === 'password' && (
                    <IconButton icon={hidden ? ViewIcon : ViewOffIcon} accessibilityLabel={hidden ? 'Show the password' : 'Hide the password'} onPress={() => setHidden((h) => !h)} />
                  )}
                </Squircle>
              </View>
              {signin ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button label="I’m signed in" style={{ flex: 1 }} fullWidth onPress={signedIn} />
                  <Button label="Cancel" variant="ghost" onPress={() => { giveBack(); router.back() }} />
                </View>
              ) : (
                <Button label="Done: give it back" fullWidth onPress={giveBack} />
              )}
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
