import { requestRecordingPermissionsAsync } from 'expo-audio'
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Cancel01Icon, KeyboardIcon, Mic01Icon, MicOff01Icon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { LIVE_WS, frameText } from '@/lib/live'
import { plainText } from '@/lib/format'
import type { Teammate } from '@/lib/types'
import type { ChatMessage } from '@/lib/use-thread'
import { fonts, motion, radius, useTheme } from '@/theme'
import { Button, IconButton, Squircle, Surface, TeammateAvatar, Text, TextSwap, haptic } from '@/ui'
import { VoiceBeam, type VoiceBeamMode } from '@/vendor/voice-glow-native/VoiceBeam'

import { LiveAudio } from '../../../modules/live-audio'

type Phase = 'connecting' | 'listening' | 'speaking' | 'working' | 'muted' | 'error'

const TASK_TIMEOUT_MS = 120_000

const plain = plainText
/** Linear RMS → the raw level voice-glow's driver expects (its base gain 5 × default sensitivity 3.1). */
const toBeam = (rms: number) => Math.min(1, rms * 15.5)

/** One spoken turn in the transcript. */
interface Line { role: 'user' | 'teammate'; text: string }

export interface VoiceModeProps {
  teammate?: Teammate
  title: string
  threadId: string
  /** Thread messages, newest first. */
  messages: ChatMessage[]
  /** A run is working in this thread right now. */
  working: boolean
  /** What the teammate is doing ("Fetching emails in Gmail"). */
  activity?: string
  /** Send a task to the teammate as a chat message; resolves to an error message or null. */
  onTask: (text: string) => Promise<string | null>
  onClose: () => void
  /** The keyboard button: type instead (default: close back to the chat). */
  onType?: () => void
  /** full: the chat's voice mode; panel: the phone-assistant sheet over other apps (src/assistant/root.tsx). */
  variant?: 'full' | 'panel'
}

/**
 * Live voice, like Claude, ChatGPT and Gemini: one streaming conversation with Gemini Live. The mic streams
 * continuously (echo-cancelled), Gemini hears when you stop and answers in about half a second, and talking over it
 * cuts it off at once. Anything needing apps goes to the teammate as a hidden chat message (run_task); Gemini says it's
 * on it and speaks the result when the reply lands. What was said is saved into the chat as it happens.
 */
export function VoiceMode({ teammate, title, threadId, messages, working, activity, onTask, onClose, onType, variant = 'full' }: VoiceModeProps) {
  const panel = variant === 'panel'
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const beamLevel = useSharedValue(0)
  const [phase, setPhase] = useState<Phase>('connecting')
  // The conversation as it's spoken (Claude-style): finished turns, then the one being spoken now.
  const [lines, setLines] = useState<Line[]>([])
  const [live, setLive] = useState<Line | null>(null)
  const [startedAt] = useState(() => new Date().toISOString())
  const scroll = useRef<ScrollView>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
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
  const latest = useRef({ messages, working })
  useEffect(() => { latest.current = { messages, working } })

  const go = (p: Phase) => { phaseRef.current = p; setPhase(p) }
  const idle = () => (tasks.current > 0 ? 'working' : 'listening') as Phase

  const close = () => {
    ws.current?.close()
    ws.current = null
    LiveAudio.stop()
    onClose()
  }

  // One session per attempt: token from our server (persona locked in), then straight to Gemini.
  useEffect(() => {
    let cancelled = false
    const subs: { remove(): void }[] = []
    const send = (msg: object) => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg)) }

    // The conversation is saved as it was spoken, in order: your words as soon as your turn ends, the teammate's when
    // it finishes. Only the spoken summary of a task result is skipped: the teammate's full reply is in the chat.
    const post = (role: 'user' | 'teammate', text: string) => {
      saving.current = saving.current
        .then(() => api('/voice/transcript', { method: 'POST', json: { thread_id: threadId, turns: [{ role, text }] } }))
        .then(() => {}, () => {})
    }
    const show = (role: Line['role'], text: string) => setLines((ls) => [...ls, { role, text }])
    const flushUser = () => {
      const t = turn.current
      if (t.userSaved || !t.user.trim()) return
      t.userSaved = true
      post('user', t.user.trim())
      show('user', t.user.trim())
      setLive(null)
    }
    const saveTurn = () => {
      const t = turn.current
      turn.current = { user: '', model: '', userSaved: false, result: false }
      if (!t.userSaved && t.user.trim()) { post('user', t.user.trim()); show('user', t.user.trim()) }
      if (t.model.trim() && !t.result) post('teammate', t.model.trim())
      if (t.model.trim()) show('teammate', t.model.trim()) // a spoken task result shows too; the chat has the full reply
      setLive(null)
    }

    const runTask = async (id: string, name: string, request: string) => {
      if (cancelled) return
      await saving.current // your words land in the chat before the task does
      const since = new Date().toISOString()
      let result: string
      const err = await onTask(request)
      if (err) {
        result = `Couldn't pass that on: ${err}`
      } else {
        result = await new Promise<string>((resolve) => {
          const started = Date.now()
          const poll = setInterval(() => {
            const { messages: ms, working: busy } = latest.current
            const fresh = ms.filter((m) => m.created_at > since && m.sender_type !== 'user').reverse()
            const blocking = fresh.find((m) => m.kind === 'approval' || m.kind === 'question' || m.kind === 'connect' || m.kind === 'error')
            const texts = fresh.filter((m) => m.kind === 'text' && m.text.trim())
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
      send({ toolResponse: { functionResponses: [{ id, name, response: { result, scheduling: 'WHEN_IDLE' } }] } })
      if (phaseRef.current === 'working' && tasks.current === 0) go('listening')
    }

    const onMessage = (raw: string) => {
      const m = JSON.parse(raw)
      if (m.setupComplete) {
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
        if (phaseRef.current !== 'speaking') setLive({ role: 'user', text: turn.current.user.trim() })
      }
      if (sc.outputTranscription?.text) {
        flushUser()
        turn.current.model += sc.outputTranscription.text
        if (!turn.current.user && pendingResults.current > 0 && !turn.current.result) {
          turn.current.result = true
          pendingResults.current -= 1
        }
        setLive({ role: 'teammate', text: turn.current.model.trim() })
      }
      if (sc.turnComplete) saveTurn()
    }

    ;(async () => {
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
        LiveAudio.addListener('onInputLevel', ({ level }) => { if (phaseRef.current !== 'speaking') beamLevel.set(toBeam(level)) }),
        LiveAudio.addListener('onOutputLevel', ({ level }) => { if (phaseRef.current === 'speaking') beamLevel.set(toBeam(level)) }),
        LiveAudio.addListener('onPlayback', ({ playing }) => {
          if (playing && phaseRef.current !== 'muted') go('speaking')
          else if (!playing && phaseRef.current === 'speaking') go(idle())
        }),
      )
    })()

    return () => {
      cancelled = true
      subs.forEach((s) => s.remove())
      const sock = ws.current
      ws.current = null
      sock?.close()
      LiveAudio.stop()
    }
  }, [threadId, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true })
    return () => back.remove()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMute = () => {
    haptic.tap()
    const muting = phaseRef.current !== 'muted'
    LiveAudio.setMuted(muting)
    go(muting ? 'muted' : idle())
  }
  // Tapping while it talks cuts it off, like talking over it.
  const tap = () => {
    if (phaseRef.current !== 'speaking') return
    haptic.tap()
    LiveAudio.clear()
    go(idle())
  }
  // Take the offer: the teammate writes the full answer in the chat (your spoken words are already saved there).
  const toText = async () => {
    if (!offer) return
    haptic.tap()
    const { request } = offer
    setOffer(null)
    close()
    await onTask(request)
  }
  const stayInVoice = () => {
    if (!offer) return
    haptic.tap()
    ws.current?.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: offer.id, name: offer.name, response: {
      result: 'They want to stay in voice. Give a short spoken version, and offer to put the full one in the chat.',
    } }] } }))
    setOffer(null)
  }
  const retry = () => { setError(''); setLive(null); go('connecting'); setAttempt((a) => a + 1) }

  const name = teammate?.name ?? title
  const label = {
    connecting: 'Connecting…',
    listening: 'Listening',
    speaking: 'Talk or tap to interrupt',
    working: working && activity ? activity : `${name} is on it`,
    muted: 'Microphone off',
    error: error || 'Something went wrong',
  }[phase]
  // What came before this call: the chat's last few messages, oldest first.
  const before = useMemo(() => messages
    .filter((m) => m.kind === 'text' && !m.local && m.created_at < startedAt && plain(m.text).trim())
    .slice(0, 6).reverse()
    .map((m): Line => ({ role: m.sender_type === 'user' ? 'user' : 'teammate', text: plain(m.text).trim() })), [messages, startedAt])
  const all = [...before, ...lines, ...(live ? [live] : [])]
  const bg = scheme === 'dark' ? '#000000' : c.canvas
  const beam: VoiceBeamMode = phase === 'listening' ? 'listening' : phase === 'speaking' ? 'speaking'
    : phase === 'working' || phase === 'connecting' ? 'processing' : 'idle'

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast)}
      exiting={FadeOut.duration(motion.duration.quick)}
      style={panel
        ? { height: '64%', borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', backgroundColor: scheme === 'dark' ? '#000' : c.canvas }
        : [StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? '#000' : c.canvas, zIndex: 20 }]}
      accessibilityViewIsModal
    >
      <VoiceBeam mode={beam} level={beamLevel} theme={scheme} />

      <View style={{ paddingTop: panel ? 16 : insets.top + 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {teammate && <TeammateAvatar teammate={teammate} size={28} state={phase === 'working' ? 'working' : 'default'} interactive={false} />}
        <Text variant="headline" numberOfLines={1}>{title}</Text>
      </View>

      {/* The transcript: earlier turns dim, the newest bright; tap anywhere to cut the teammate off. */}
      <View style={{ flex: 1 }}>
        <ScrollView ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 24, paddingTop: 48, paddingBottom: 24, gap: 22 }}>
          <Pressable onPress={tap} style={{ gap: 22 }} accessibilityRole="button" accessibilityLabel={label}>
            {all.map((l, i) => {
              const recent = i >= all.length - 2
              return l.role === 'user' ? (
                <Squircle key={i} style={{ alignSelf: 'flex-end', maxWidth: '86%', borderRadius: radius.lg, backgroundColor: c.panel2, paddingHorizontal: 16, paddingVertical: 12, opacity: recent ? 1 : 0.6 }}>
                  <Text variant="body" style={{ fontSize: 17, lineHeight: 24 }}>{l.text}</Text>
                </Squircle>
              ) : (
                <Text key={i} style={{ fontFamily: fonts.regular, fontSize: 24, lineHeight: 32, letterSpacing: -0.3, color: recent ? c.ink : c.ink3 }}>{l.text}</Text>
              )
            })}
          </Pressable>
        </ScrollView>
        {/* Older lines fade out under the header. */}
        <Canvas style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 56 }} pointerEvents="none">
          <Rect x={0} y={0} width={2000} height={56}>
            <LinearGradient start={vec(0, 0)} end={vec(0, 56)} colors={[bg, `${bg}00`]} />
          </Rect>
        </Canvas>
      </View>

      <View style={{ alignItems: 'center', gap: 12, paddingBottom: insets.bottom + 132, paddingTop: 4 }}>
        <TextSwap variant="label" color="ink3">{label}</TextSwap>
        {phase === 'error' && <Button label="Try again" variant="soft" onPress={retry} />}
      </View>

      {offer && (
        <Animated.View
          entering={FadeIn.duration(motion.duration.fast)}
          exiting={FadeOut.duration(motion.duration.quick)}
          style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 120 }}
        >
          <Surface radius={24} padding={16} elevated style={{ gap: 12 }}>
            <View style={{ gap: 2 }}>
              <Text variant="headline">Better as text</Text>
              <Text variant="caption" color="ink3">{offer.reason || `${name} will write it out in the chat so you can read and copy it.`}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="Keep talking" variant="outline" onPress={stayInVoice} style={{ flex: 1 }} />
              <Button label="Switch to text" onPress={toText} style={{ flex: 1 }} />
            </View>
          </Surface>
        </Animated.View>
      )}

      <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
        <IconButton icon={KeyboardIcon} variant="soft" size={56} iconSize={22} round accessibilityLabel="Type instead" onPress={onType ? () => { ws.current?.close(); ws.current = null; LiveAudio.stop(); onType() } : close} />
        <IconButton
          icon={phase === 'muted' ? MicOff01Icon : Mic01Icon}
          swapKey={phase === 'muted' ? 'off' : 'on'}
          variant={phase === 'muted' ? 'solid' : 'soft'}
          size={56}
          iconSize={22}
          round
          disabled={phase === 'connecting' || phase === 'error'}
          accessibilityLabel={phase === 'muted' ? 'Turn microphone on' : 'Mute microphone'}
          onPress={toggleMute}
        />
        <IconButton icon={Cancel01Icon} variant="soft" size={56} iconSize={22} round accessibilityLabel="End voice mode" onPress={close} />
      </View>
    </Animated.View>
  )
}
