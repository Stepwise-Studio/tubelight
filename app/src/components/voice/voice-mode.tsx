import { requestRecordingPermissionsAsync } from 'expo-audio'
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia'
import { useEffect, useRef, useState } from 'react'
import { BackHandler, ScrollView, View } from 'react-native'
import Animated, { FadeIn, FadeOut, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Cancel01Icon, Mic01Icon, MicOff01Icon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { LIVE_WS, frameText } from '@/lib/live'
import { plainText } from '@/lib/format'
import { Phone } from '@/lib/phone'
import type { Teammate } from '@/lib/types'
import type { ChatMessage } from '@/lib/use-thread'
import { motion, radius, useTheme } from '@/theme'
import { Button, IconButton, Squircle, Surface, TeammateAvatar, Text, TextSwap, haptic } from '@/ui'
import { VoiceBeam, type VoiceBeamMode } from '@/vendor/voice-glow-native/VoiceBeam'

import { LiveAudio } from '../../../modules/live-audio'

type Phase = 'connecting' | 'listening' | 'speaking' | 'working' | 'muted' | 'error'

const TASK_TIMEOUT_MS = 120_000

const plain = plainText
/** The analyser's RMS and voice bands → voice-glow's raw input: base gain 5 (bands 1.7) × default sensitivity 3.1. */
const toBeam = (level: number, bands?: number[]) =>
  bands?.length === 3 ? [level * 15.5, bands[0] * 5.27, bands[1] * 5.27, bands[2] * 5.27] : [level * 15.5]

/** One spoken turn. `saved`: it goes into the chat as a message (a spoken task result doesn't: the reply is there). */
export interface VoiceTurn { role: 'user' | 'teammate'; text: string; saved: boolean }

export interface VoiceSessionOptions {
  /** The session runs while true. */
  enabled: boolean
  threadId: string
  /** Thread messages, newest first. */
  messages: ChatMessage[]
  /** A run is working in this thread right now. */
  working: boolean
  /** What the teammate is doing ("Fetching emails in Gmail"). */
  activity?: string
  /** Who's talking, for labels. */
  name: string
  /** Send a task to the teammate as a chat message; resolves to an error message or null. */
  onTask: (text: string) => Promise<string | null>
  /** Voice ended from inside (Back, "Switch to text"). */
  onEnd: () => void
  /** What was on the phone's screen when the assistant was summoned (modules/phone), for "what's this?". */
  screen?: { app: string | null; text: string | null; image: string | null } | null
}

export type VoiceSession = ReturnType<typeof useVoiceSession>

/**
 * Live voice, like Claude, ChatGPT and Gemini: one streaming conversation with Gemini Live. The mic streams
 * continuously (echo-cancelled), Gemini hears when you stop and answers in about half a second, and talking over it
 * cuts it off at once. Anything needing apps goes to the teammate as a hidden chat message (run_task); Gemini says it's
 * on it and speaks the result when the reply lands. Each turn is saved into the chat as it ends and shows live
 * (`live`) while it's said, so the chat reads like texting, the teammate's words appearing as they're spoken.
 */
export function useVoiceSession({ enabled, threadId, messages, working, activity, name, onTask, onEnd, screen }: VoiceSessionOptions) {
  const beamInput = useSharedValue<number[]>([0])
  const [phase, setPhase] = useState<Phase>('connecting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [turns, setTurns] = useState<VoiceTurn[]>([])
  const [live, setLive] = useState<VoiceTurn | null>(null)
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString())
  // "Better as text": the teammate offered to continue in the chat (code, tables, long lists).
  const [offer, setOffer] = useState<{ id: string; name: string; request: string; reason: string } | null>(null)

  const ws = useRef<WebSocket | null>(null)
  const phaseRef = useRef<Phase>('connecting')
  const tasks = useRef(0) // tasks in flight
  // Tasks go to the teammate one after another: a second message while the first run waits would supersede it.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const turn = useRef({ user: '', model: '', userSaved: false, result: false })
  const saving = useRef<Promise<void>>(Promise.resolve())
  const pendingResults = useRef(0) // model turns still to come that speak a task result (not saved: the chat has it)
  const latest = useRef({ messages, working, onTask, onEnd })
  useEffect(() => { latest.current = { messages, working, onTask, onEnd } })

  const go = (p: Phase) => { phaseRef.current = p; setPhase(p) }
  const idle = () => (tasks.current > 0 ? 'working' : 'listening') as Phase
  const stop = () => {
    const sock = ws.current
    ws.current = null
    sock?.close()
    LiveAudio.stop()
  }

  // One session per attempt: token from our server (persona locked in), then straight to Gemini.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const subs: { remove(): void }[] = []
    turn.current = { user: '', model: '', userSaved: false, result: false }
    tasks.current = 0
    pendingResults.current = 0
    const send = (msg: object) => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg)) }

    // The conversation is saved as it was spoken, in order: your words as soon as your turn ends, the teammate's when
    // it finishes. Only the spoken summary of a task result is skipped: the teammate's full reply is in the chat.
    const post = (role: 'user' | 'teammate', text: string) => {
      saving.current = saving.current
        .then(() => api('/voice/transcript', { method: 'POST', json: { thread_id: threadId, turns: [{ role, text }] } }))
        .then(() => {}, () => {})
    }
    const keep = (t: VoiceTurn) => setTurns((ts) => [...ts, t])
    const flushUser = () => {
      const t = turn.current
      if (t.userSaved || !t.user.trim()) return
      t.userSaved = true
      post('user', t.user.trim())
      keep({ role: 'user', text: t.user.trim(), saved: true })
      setLive(null)
    }
    const saveTurn = () => {
      const t = turn.current
      turn.current = { user: '', model: '', userSaved: false, result: false }
      if (!t.userSaved && t.user.trim()) { post('user', t.user.trim()); keep({ role: 'user', text: t.user.trim(), saved: true }) }
      if (t.model.trim() && !t.result) post('teammate', t.model.trim())
      if (t.model.trim()) keep({ role: 'teammate', text: t.model.trim(), saved: !t.result })
      setLive(null)
    }

    const runTask = async (id: string, fname: string, request: string) => {
      if (cancelled) return
      await saving.current // your words land in the chat before the task does
      const since = new Date().toISOString()
      let result: string
      const err = await latest.current.onTask(request)
      if (err) {
        result = `Couldn't pass that on: ${err}`
      } else {
        result = await new Promise<string>((resolve) => {
          const started = Date.now()
          const poll = setInterval(() => {
            const { messages: ms, working: busy } = latest.current
            const fresh = ms.filter((m) => m.created_at > since && m.sender_type !== 'user').reverse()
            const blocking = fresh.find((m) => m.kind === 'approval' || m.kind === 'question' || m.kind === 'connect' || m.kind === 'error')
            const texts = fresh.filter((m) => m.kind === 'text' && m.text.trim() && !m.meta?.voice)
            const timedOut = Date.now() - started > TASK_TIMEOUT_MS
            if (!blocking && !(texts.length && !busy) && !timedOut) return
            clearInterval(poll)
            const said = texts.map((m) => plain(m.text)).join(' ').slice(0, 2000)
            resolve(
              blocking?.kind === 'approval' ? `${said} Waiting for the user's approval in the chat: ${plain(blocking.text)}`.trim()
                : blocking?.kind === 'question' ? `${said} The teammate needs an answer in the chat: ${plain(blocking.text)}`.trim()
                : blocking?.kind === 'connect' ? `${said} An app needs connecting first; there's a Connect button in the chat.`.trim()
                : blocking?.kind === 'error' ? `It failed: ${plain(blocking.text)}`
                : said || 'Still working on it; the answer will show up in the chat.',
            )
          }, 400)
        })
      }
      tasks.current -= 1
      pendingResults.current += 1
      send({ toolResponse: { functionResponses: [{ id, name: fname, response: { result, scheduling: 'WHEN_IDLE' } }] } })
      if (phaseRef.current === 'working' && tasks.current === 0) go('listening')
    }

    const onMessage = (raw: string) => {
      const m = JSON.parse(raw)
      if (m.setupComplete) {
        if (screen?.text || screen?.image) { // seen, not said: so "what's this?" and "reply to this" work
          if (screen.text) {
            send({ clientContent: { turnComplete: false, turns: [{ role: 'user', parts: [{ text:
              `(Not said aloud. When they called you they were in ${screen.app ?? 'an app'}; its screen shows:\n${screen.text})` }] }] } })
          }
          if (screen.image) send({ realtimeInput: { video: { data: screen.image, mimeType: 'image/jpeg' } } })
        }
        LiveAudio.start().then(() => { if (!cancelled) { go('listening'); haptic.light() } }, (e: Error) => {
          setError(e.message || 'The microphone is unavailable.'); go('error')
        })
        return
      }
      if (m.toolCall) {
        flushUser()
        for (const fc of m.toolCall.functionCalls ?? []) {
          if (fc.name === 'switch_to_text') {
            haptic.light()
            setOffer({ id: fc.id, name: fc.name, request: String(fc.args?.request ?? ''), reason: String(fc.args?.reason ?? '') })
            continue
          }
          tasks.current += 1
          if (phaseRef.current === 'listening') go('working')
          queue.current = queue.current.then(() => runTask(fc.id, fc.name, String(fc.args?.request ?? '')))
        }
        return
      }
      const sc = m.serverContent
      if (!sc) return
      if (sc.interrupted) {
        LiveAudio.clear() // barge-in: stop talking at once
        go(idle())
      }
      for (const p of sc.modelTurn?.parts ?? []) {
        if (p.inlineData?.data) { flushUser(); LiveAudio.play(p.inlineData.data) }
      }
      if (sc.inputTranscription?.text) {
        turn.current.user += sc.inputTranscription.text
        if (!turn.current.userSaved) setLive({ role: 'user', text: turn.current.user.trim(), saved: true })
      }
      if (sc.outputTranscription?.text) {
        flushUser()
        turn.current.model += sc.outputTranscription.text
        if (!turn.current.user && pendingResults.current > 0 && !turn.current.result) {
          turn.current.result = true
          pendingResults.current -= 1
        }
        setLive({ role: 'teammate', text: turn.current.model.trim(), saved: !turn.current.result })
      }
      if (sc.turnComplete) saveTurn()
    }

    ;(async () => {
      // A fresh conversation each time voice starts (or is retried).
      setTurns([]); setLive(null); setOffer(null); setError(''); go('connecting')
      setStartedAt(new Date().toISOString())
      const perm = await requestRecordingPermissionsAsync()
      if (!perm.granted) { setError('Tubelight needs the microphone for voice mode.'); go('error'); return }
      let token: string
      try {
        ({ token } = await api<{ token: string }>('/voice/live', { method: 'POST', json: { thread_id: threadId } }))
      } catch (e) {
        setError((e as Error).message); go('error'); return
      }
      if (cancelled) return
      const sock = new WebSocket(`${LIVE_WS}?access_token=${encodeURIComponent(token)}`)
      sock.binaryType = 'arraybuffer'
      ws.current = sock
      sock.onopen = () => sock.send(JSON.stringify({ setup: {} })) // the setup comes from the token
      sock.onmessage = (e) => onMessage(frameText(e.data))
      sock.onerror = () => {}
      sock.onclose = (e) => {
        if (cancelled || ws.current !== sock) return
        LiveAudio.stop()
        setError(e.code === 1000 ? 'The call ended.' : 'The connection dropped.')
        go('error')
      }
      subs.push(
        LiveAudio.addListener('onMic', ({ data }) => send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } })),
        LiveAudio.addListener('onInputLevel', ({ level, bands }) => { if (phaseRef.current !== 'speaking') beamInput.set(toBeam(level, bands)) }),
        LiveAudio.addListener('onOutputLevel', ({ level, bands }) => { if (phaseRef.current === 'speaking') beamInput.set(toBeam(level, bands)) }),
        LiveAudio.addListener('onPlayback', ({ playing }) => {
          if (playing && phaseRef.current !== 'muted') go('speaking')
          else if (!playing && phaseRef.current === 'speaking') go(idle())
        }),
      )
    })()

    const back = BackHandler.addEventListener('hardwareBackPress', () => { latest.current.onEnd(); return true })
    return () => {
      cancelled = true
      back.remove()
      subs.forEach((s) => s.remove())
      stop()
    }
  }, [enabled, threadId, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMute = () => {
    haptic.tap()
    const muting = phaseRef.current !== 'muted'
    LiveAudio.setMuted(muting)
    go(muting ? 'muted' : idle())
  }
  // Tapping while it talks cuts it off, like talking over it.
  const interrupt = () => {
    if (phaseRef.current !== 'speaking') return
    haptic.tap()
    LiveAudio.clear()
    go(idle())
  }
  // Take the offer: the teammate writes the full answer in the chat (your spoken words are already saved there).
  const takeOffer = async () => {
    if (!offer) return
    haptic.tap()
    const { request } = offer
    setOffer(null)
    stop()
    latest.current.onEnd()
    await latest.current.onTask(request)
  }
  const stayInVoice = () => {
    if (!offer) return
    haptic.tap()
    ws.current?.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: offer.id, name: offer.name, response: {
      result: 'They want to stay in voice. Give a short spoken version, and offer to put the full one in the chat.',
    } }] } }))
    setOffer(null)
  }
  const retry = () => { setAttempt((a) => a + 1) }

  const label = {
    connecting: 'Connecting…',
    listening: 'Listening',
    speaking: 'Talk or tap to interrupt',
    working: working && activity ? activity : `${name} is on it`,
    muted: 'Microphone off',
    error: error || 'Something went wrong',
  }[phase]
  const beam: VoiceBeamMode = phase === 'listening' ? 'listening' : phase === 'speaking' ? 'speaking'
    : phase === 'working' || phase === 'connecting' ? 'processing' : 'idle'

  return { phase, label, beam, beamInput, turns, live, startedAt, offer, toggleMute, interrupt, takeOffer, stayInVoice, retry, stop }
}

/** Turns said this session that the chat doesn't hold yet as messages, then the one being said (oldest first). */
export function unsavedTurns(v: VoiceSession, messages: ChatMessage[]): VoiceTurn[] {
  const left = messages.filter((m) => m.created_at >= v.startedAt && m.meta?.voice)
  const waiting = v.turns.filter((t) => {
    if (!t.saved) return false // a spoken task result: the teammate's full reply is already in the chat
    const i = left.findIndex((m) => (m.sender_type === 'user') === (t.role === 'user') && m.text.trim() === t.text)
    if (i < 0) return true
    left.splice(i, 1)
    return false
  })
  return [...waiting, ...(v.live ? [v.live] : [])]
}

/**
 * libraries.dev voice-glow, `type="mobile"`: the glow lives on the phone's own bottom edge, hugging its rounded
 * corners, over whatever is on screen. A layer of its own (full screen, no touches), never boxed into a panel.
 */
export function VoiceGlow({ v }: { v: VoiceSession }) {
  const { scheme } = useTheme()
  const [radius] = useState(() => Phone?.screenRadius() ?? 0)
  return <VoiceBeam mode={v.beam} input={v.beamInput} theme={scheme} radius={radius} style={ON_TOP} />
}
const ON_TOP = { zIndex: 30 }

/** The bottom of a chat in voice mode: what's happening, mute and end, over a soft fade (the chat shows through). */
export function VoiceControls({ v, name, onEnd, padBottom }: {
  v: VoiceSession; name: string; onEnd: () => void; padBottom: number
}) {
  const { c } = useTheme()
  const [size, setSize] = useState({ w: 0, h: 0 })
  return (
    <View style={{ paddingBottom: padBottom + 24, paddingTop: 56 }} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {size.h > 0 && (
        <Canvas style={{ position: 'absolute', left: 0, top: 0, width: size.w, height: size.h }} pointerEvents="none">
          <Rect x={0} y={0} width={size.w} height={size.h}>
            <LinearGradient start={vec(0, 0)} end={vec(0, size.h)} positions={[0, 0.45, 1]}
              colors={[`${c.canvas}00`, `${c.canvas}cc`, `${c.canvas}f0`]} />
          </Rect>
        </Canvas>
      )}
      {v.offer && (
        <Animated.View entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}
          style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
          <Surface radius={24} padding={16} elevated style={{ gap: 12 }}>
            <View style={{ gap: 2 }}>
              <Text variant="headline">Better as text</Text>
              <Text variant="caption" color="ink3">{v.offer.reason || `${name} will write it out in the chat so you can read and copy it.`}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="Keep talking" variant="outline" onPress={v.stayInVoice} style={{ flex: 1 }} />
              <Button label="Switch to text" onPress={v.takeOffer} style={{ flex: 1 }} />
            </View>
          </Surface>
        </Animated.View>
      )}
      <View style={{ alignItems: 'center', gap: 16 }}>
        <TextSwap variant="label" color="ink2">{v.label}</TextSwap>
        {v.phase === 'error' ? <Button label="Try again" variant="soft" onPress={v.retry} /> : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 32 }}>
            <IconButton
              icon={v.phase === 'muted' ? MicOff01Icon : Mic01Icon}
              swapKey={v.phase === 'muted' ? 'off' : 'on'}
              variant={v.phase === 'muted' ? 'solid' : 'soft'}
              size={60}
              iconSize={24}
              round
              disabled={v.phase === 'connecting'}
              accessibilityLabel={v.phase === 'muted' ? 'Turn microphone on' : 'Mute microphone'}
              onPress={v.toggleMute}
            />
            <IconButton icon={Cancel01Icon} variant="soft" size={60} iconSize={24} round accessibilityLabel="End voice mode" onPress={onEnd} />
          </View>
        )}
      </View>
    </View>
  )
}

export interface VoiceModeProps {
  teammate?: Teammate
  title: string
  threadId: string
  messages: ChatMessage[]
  working: boolean
  activity?: string
  onTask: (text: string) => Promise<string | null>
  onClose: () => void
  screen?: VoiceSessionOptions['screen']
}

/**
 * The phone-assistant sheet over other apps (src/assistant/root.tsx): the chat as bubbles (the last few messages and
 * what's said now, the teammate's words appearing as they're spoken), with the voice controls below.
 */
export function VoiceMode({ teammate, title, threadId, messages, working, activity, onTask, onClose, screen }: VoiceModeProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const scroll = useRef<ScrollView>(null)
  const name = teammate?.name ?? title
  const v = useVoiceSession({ enabled: true, threadId, messages, working, activity, name, onTask, onEnd: onClose, screen })
  const bubbles = [
    ...messages.filter((m) => m.kind === 'text' && !m.local && plain(m.text).trim()).slice(0, 8).reverse()
      .map((m) => ({ mine: m.sender_type === 'user', text: plain(m.text).trim() })),
    ...unsavedTurns(v, messages).map((t) => ({ mine: t.role === 'user', text: t.text })),
  ]
  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast)}
      exiting={FadeOut.duration(motion.duration.quick)}
      style={{ height: '66%', borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', backgroundColor: scheme === 'dark' ? '#000' : c.canvas }}
      accessibilityViewIsModal
    >
      <View style={{ paddingTop: 16, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {teammate && <TeammateAvatar teammate={teammate} size={28} state={v.phase === 'working' ? 'working' : 'default'} interactive={false} />}
        <Text variant="headline" numberOfLines={1}>{title}</Text>
      </View>
      <ScrollView ref={scroll} style={{ flex: 1 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}
        onTouchEnd={v.interrupt}>
        {bubbles.map((b, i) => (
          <Squircle key={i} style={{ alignSelf: b.mine ? 'flex-end' : 'flex-start', maxWidth: '84%', borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: b.mine ? c.tube : c.panel2 }}>
            <Text variant="body" style={{ color: b.mine ? '#fff' : c.ink }}>{b.text}</Text>
          </Squircle>
        ))}
      </ScrollView>
      <VoiceControls v={v} name={name} onEnd={onClose} padBottom={insets.bottom} />
      <VoiceGlow v={v} />
    </Animated.View>
  )
}
