import { requestRecordingPermissionsAsync } from 'expo-audio'
import { useEffect, useRef, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Cancel01Icon, KeyboardIcon, Mic01Icon, MicOff01Icon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { stripCues } from '@/lib/format'
import type { Teammate } from '@/lib/types'
import type { ChatMessage } from '@/lib/use-thread'
import { motion, useTheme } from '@/theme'
import { Button, IconButton, TeammateAvatar, Text, TextSwap, haptic } from '@/ui'
import { VoiceBeam, type VoiceBeamMode } from '@/vendor/voice-glow-native/VoiceBeam'

import { LiveAudio } from '../../../modules/live-audio'

type Phase = 'connecting' | 'listening' | 'speaking' | 'working' | 'muted' | 'error'

const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'
const TASK_TIMEOUT_MS = 120_000

/** Gemini Live sends JSON in binary frames. */
const utf8 = (buf: ArrayBuffer) => {
  const TD = (globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } }).TextDecoder
  const bytes = new Uint8Array(buf)
  if (TD) return new TD().decode(bytes)
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++]
    const cp = b < 0x80 ? b
      : b < 0xe0 ? ((b & 0x1f) << 6) | (bytes[i++] & 0x3f)
      : b < 0xf0 ? ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
      : ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
    out += String.fromCodePoint(cp)
  }
  return out
}
const plain = (s: string) => stripCues(s).replace(/```[\s\S]*?```/g, ' (code in the chat) ').replace(/[*_`#>[\]]/g, '').replace(/\s+/g, ' ').trim()
/** Linear RMS → the raw level voice-glow's driver expects (its base gain 5 × default sensitivity 3.1). */
const toBeam = (rms: number) => Math.min(1, rms * 15.5)

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
}

/**
 * Live voice, like Claude, ChatGPT and Gemini: one streaming conversation with Gemini Live. The mic streams
 * continuously (echo-cancelled), Gemini hears when you stop and answers in about half a second, and talking over it
 * cuts it off at once. Anything needing apps goes to the teammate as a hidden chat message (run_task); Gemini says it's
 * on it and speaks the result when the reply lands. What was said is saved into the chat as it happens.
 */
export function VoiceMode({ teammate, title, threadId, messages, working, activity, onTask, onClose }: VoiceModeProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const beamLevel = useSharedValue(0)
  const [phase, setPhase] = useState<Phase>('connecting')
  const [caption, setCaption] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

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
    const flushUser = () => {
      const t = turn.current
      if (t.userSaved || !t.user.trim()) return
      t.userSaved = true
      post('user', t.user.trim())
    }
    const saveTurn = () => {
      const t = turn.current
      turn.current = { user: '', model: '', userSaved: false, result: false }
      if (!t.userSaved && t.user.trim()) post('user', t.user.trim())
      if (t.model.trim() && !t.result) post('teammate', t.model.trim())
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
        if (phaseRef.current !== 'speaking') setCaption(turn.current.user.trim())
      }
      if (sc.outputTranscription?.text) {
        flushUser()
        turn.current.model += sc.outputTranscription.text
        if (!turn.current.user && pendingResults.current > 0 && !turn.current.result) {
          turn.current.result = true
          pendingResults.current -= 1
        }
        setCaption(turn.current.model.trim())
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
      sock.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : utf8(e.data as ArrayBuffer))
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
  const retry = () => { setError(''); setCaption(''); go('connecting'); setAttempt((a) => a + 1) }

  const name = teammate?.name ?? title
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

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast)}
      exiting={FadeOut.duration(motion.duration.quick)}
      style={[StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? '#000' : c.canvas, zIndex: 20 }]}
      accessibilityViewIsModal
    >
      <VoiceBeam mode={beam} level={beamLevel} theme={scheme} />

      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {teammate && <TeammateAvatar teammate={teammate} size={28} state={phase === 'working' ? 'working' : 'default'} interactive={false} />}
        <Text variant="headline" numberOfLines={1}>{title}</Text>
      </View>

      <Pressable onPress={tap} style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 140 }} accessibilityRole="button" accessibilityLabel={label}>
        <View style={{ alignItems: 'center', gap: 14 }}>
          <TextSwap variant="label" color="ink3">{label}</TextSwap>
          {!!caption && phase !== 'error' && (
            <Text variant="heading" numberOfLines={6} style={{ textAlign: 'center' }}>{caption}</Text>
          )}
          {phase === 'error' && <Button label="Try again" variant="soft" onPress={retry} />}
        </View>
      </Pressable>

      <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
        <IconButton icon={KeyboardIcon} variant="soft" size={56} iconSize={22} round accessibilityLabel="Type instead" onPress={close} />
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
