import {
  RecordingPresets, createAudioPlayer, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
  type AudioPlayer,
} from 'expo-audio'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Cancel01Icon, KeyboardIcon, StopIcon, Tick02Icon } from '@hugeicons/core-free-icons'

import { ApiError, BASE, api, authHeaders } from '@/lib/api'
import { stripCues } from '@/lib/format'
import type { Teammate } from '@/lib/types'
import type { ChatMessage } from '@/lib/use-thread'
import { motion, useTheme } from '@/theme'
import { IconButton, TeammateAvatar, Text, TextSwap, haptic } from '@/ui'

import { VoiceGlow } from './voice-glow'

type Phase = 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'stopped'

const SPEECH = 0.32 // minimum level that counts as talking
const CALIBRATE_MS = 400 // listen to the room first; talking must rise clearly above it
const MIN_TALK_MS = 300 // a cough or a door isn't a turn
const SILENCE_MS = 1100 // this long below it after talking ends the turn
const MAX_TURN_MS = 60_000
// Module constant: useAudioRecorder recreates (and releases) the recorder whenever its options object changes.
const RECORDING = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true }

const toLevel = (db?: number) => (db === undefined ? 0 : Math.max(0, Math.min(1, (db + 55) / 45)))
const plain = (s: string) => stripCues(s).replace(/```[\s\S]*?```/g, ' (code in the chat) ').replace(/[*_`#>[\]]/g, '').replace(/\s+/g, ' ').trim()

export interface VoiceModeProps {
  teammate?: Teammate
  title: string
  /** Thread messages, newest first. */
  messages: ChatMessage[]
  live: boolean
  onSend: (text: string) => Promise<void>
  onClose: () => void
}

/**
 * Hands-free conversation over the thread: listen → (you stop talking) → transcribe → send → the teammate's
 * reply is spoken part by part → listen again. Tap anywhere to interrupt or to end your turn early.
 */
export function VoiceMode({ teammate, title, messages, live, onSend, onClose }: VoiceModeProps) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const recorder = useAudioRecorder(RECORDING)
  const rec = useAudioRecorderState(recorder, 80)
  const level = useSharedValue(0)
  const [phase, setPhase] = useState<Phase>('starting')
  const [caption, setCaption] = useState('')
  const [note, setNote] = useState('')

  const phaseRef = useRef<Phase>('starting')
  const turn = useRef({ startedAt: 0, spoke: false, lastLoud: 0, floor: 0, loudMs: 0, lastTick: 0, sent: '', sawLive: false })
  const players = useRef<AudioPlayer[]>([])
  const closed = useRef(false)

  const go = (p: Phase) => { phaseRef.current = p; setPhase(p) }

  const stopPlayers = () => {
    for (const p of players.current) { try { p.remove() } catch {} }
    players.current = []
  }

  const close = () => { closed.current = true; stopPlayers(); onClose() }

  const listen = async () => {
    if (closed.current) return
    stopPlayers()
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      recorder.record()
      const now = Date.now()
      turn.current = { ...turn.current, startedAt: now, spoke: false, lastLoud: 0, floor: 0, loudMs: 0, lastTick: now }
      setNote('')
      go('listening')
    } catch (e) {
      setNote(`The microphone is busy. Tap to try again.${__DEV__ ? ` (${(e as Error).message})` : ''}`)
      go('stopped')
    }
  }

  const endTurn = async () => {
    if (phaseRef.current !== 'listening') return
    go('transcribing')
    level.value = 0
    try {
      await recorder.stop()
      const uri = recorder.uri
      if (!uri) throw new Error('No recording')
      const audio = await (await fetch(uri)).arrayBuffer()
      const { text } = await api<{ text: string }>('/voice/transcribe', { method: 'POST', body: audio, headers: { 'Content-Type': 'audio/m4a' } })
      if (!text.trim()) { setNote('I didn’t catch that.'); return listen() }
      setCaption(text)
      turn.current = { ...turn.current, sent: text, sawLive: false }
      go('thinking')
      await onSend(text)
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Couldn’t hear that. Tap to try again.')
      go('stopped')
    }
  }

  const speak = async (m: ChatMessage) => {
    go('speaking')
    setCaption(plain(m.text))
    try {
      const [{ parts }, headers] = await Promise.all([api<{ parts: number }>(`/voice/messages/${m.id}`), authHeaders()])
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
      const load = (k: number) => createAudioPlayer({ uri: `${BASE}/voice/messages/${m.id}/${k}`, headers })
      const play = (k: number, player: AudioPlayer) => {
        if (phaseRef.current !== 'speaking' || closed.current) return
        // Fetch the next part while this one plays, so there's no gap between sentences.
        const next = k + 1 < parts ? load(k + 1) : null
        players.current = next ? [player, next] : [player]
        const sub = player.addListener('playbackStatusUpdate', (s) => {
          if (!s.didJustFinish) return
          sub.remove()
          player.remove()
          if (next) play(k + 1, next)
          else listen()
        })
        player.play()
      }
      if (parts > 0) play(0, load(0))
      else listen()
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Couldn’t play the reply. It’s in the chat.')
      go('stopped')
    }
  }

  // Start listening on open; release everything on close.
  useEffect(() => {
    (async () => {
      const perm = await requestRecordingPermissionsAsync()
      if (!perm.granted) { setNote('Allow microphone access in Settings to talk.'); return go('stopped') }
      listen()
    })()
    const back = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true })
    return () => {
      back.remove()
      closed.current = true
      stopPlayers()
      if (recorder.isRecording) recorder.stop().catch(() => {})
      setAudioModeAsync({ allowsRecording: false }).catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Mic level drives the glow; a pause after talking ends the turn.
  useEffect(() => {
    if (phaseRef.current !== 'listening') return
    const l = toLevel(rec.metering)
    const now = Date.now()
    const t = turn.current
    const dt = now - t.lastTick
    t.lastTick = now
    if (now - t.startedAt < CALIBRATE_MS) { t.floor = Math.max(t.floor, l); return }
    level.value = Math.max(0, l - t.floor) / (1 - Math.min(t.floor, 0.9)) // the glow shows your voice, not the room
    if (l > Math.max(SPEECH, t.floor + 0.18)) {
      t.lastLoud = now
      t.loudMs += dt
      if (t.loudMs >= MIN_TALK_MS) t.spoke = true
    }
    if ((t.spoke && now - t.lastLoud > SILENCE_MS) || now - t.startedAt > MAX_TURN_MS) endTurn()
  }, [rec.metering, rec.durationMillis]) // eslint-disable-line react-hooks/exhaustive-deps

  // Wait for the run to finish, then speak the reply to what was just sent.
  useEffect(() => {
    if (phaseRef.current !== 'thinking') return
    const t = turn.current
    if (live) { t.sawLive = true; return }
    const mine = messages.findIndex((m) => m.sender_type === 'user' && m.text === t.sent)
    const reply = messages.slice(0, Math.max(mine, 0)).reverse().find((m) => m.sender_type === 'teammate')
    if (reply?.kind === 'text' && reply.text.trim()) speak(reply)
    else if (reply) { haptic.warning(); close() } // a question, approval or connect card waits in the chat
    // No reply yet: only an error if a run started and ended (it shows up a beat after sending).
    else if (t.sawLive) { setNote('No reply came back. Tap to try again.'); go('stopped') }
  }, [live, messages]) // eslint-disable-line react-hooks/exhaustive-deps


  const tap = () => {
    haptic.tap()
    if (phaseRef.current === 'listening') endTurn()
    else if (phaseRef.current === 'speaking') listen() // interrupt
    else if (phaseRef.current === 'stopped') listen()
  }

  const label = {
    starting: 'Starting…',
    listening: 'Listening',
    transcribing: 'Got it',
    thinking: `${teammate?.name ?? title} is thinking`,
    speaking: 'Tap to interrupt',
    stopped: 'Paused',
  }[phase]
  const glow = phase === 'listening' ? 'listening' : phase === 'speaking' ? 'speaking' : phase === 'thinking' || phase === 'transcribing' ? 'thinking' : 'idle'
  const action = phase === 'listening'
    ? { icon: Tick02Icon, label: 'Done talking' }
    : phase === 'speaking' ? { icon: StopIcon, label: 'Interrupt' } : null

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast)}
      exiting={FadeOut.duration(motion.duration.quick)}
      style={[StyleSheet.absoluteFill, { backgroundColor: c.canvas, zIndex: 20 }]}
      accessibilityViewIsModal
    >
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}><VoiceGlow state={glow} level={level} height={340} /></View>

      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' }}>
        <IconButton icon={Cancel01Icon} accessibilityLabel="End voice mode" onPress={close} />
        <View style={{ flex: 1, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
          {teammate && <TeammateAvatar teammate={teammate} size={28} state={phase === 'thinking' ? 'working' : 'default'} live interactive={false} />}
          <Text variant="headline" numberOfLines={1}>{title}</Text>
        </View>
        <View style={{ width: 44 }} />
      </View>

      <Pressable onPress={tap} style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 120 }} accessibilityRole="button" accessibilityLabel={label}>
        <View style={{ alignItems: 'center', gap: 14 }}>
          <TextSwap variant="label" color="ink3">{label}</TextSwap>
          {!!caption && (
            <Animated.View key={caption} entering={FadeIn.duration(motion.duration.fast)}>
              <Text variant="heading" numberOfLines={7} style={{ textAlign: 'center' }}>{caption}</Text>
            </Animated.View>
          )}
          {!!note && <Text variant="caption" color="ink2" style={{ textAlign: 'center' }}>{note}</Text>}
        </View>
      </Pressable>

      <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
        <IconButton icon={KeyboardIcon} variant="soft" size={52} iconSize={22} accessibilityLabel="Type instead" onPress={close} />
        <View style={{ width: 72, height: 72, alignItems: 'center', justifyContent: 'center' }}>
          {action ? (
            <IconButton icon={action.icon} swapKey={action.label} variant="solid" size={72} iconSize={28} accessibilityLabel={action.label} onPress={tap} />
          ) : phase === 'stopped' ? null : <ActivityIndicator color={c.ink2} />}
        </View>
        <View style={{ width: 52 }} />
      </View>
    </Animated.View>
  )
}
