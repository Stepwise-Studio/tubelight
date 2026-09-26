import {
  RecordingPresets, createAudioPlayer, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
  type AudioPlayer,
} from 'expo-audio'
import { useEffect, useRef, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Cancel01Icon, KeyboardIcon, Mic01Icon, MicOff01Icon } from '@hugeicons/core-free-icons'

import { ApiError, BASE, api, authHeaders } from '@/lib/api'
import { stripCues } from '@/lib/format'
import type { Teammate } from '@/lib/types'
import type { ChatMessage } from '@/lib/use-thread'
import { VoiceBeam, type VoiceBeamMode } from '@/vendor/voice-glow-native/VoiceBeam'
import { motion, useTheme } from '@/theme'
import { IconButton, TeammateAvatar, Text, TextSwap, haptic } from '@/ui'

type Phase = 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted' | 'stopped'

const SPEECH = 0.32 // minimum level that counts as talking
const CALIBRATE_MS = 400 // listen to the room (or the teammate's own voice) first; talking must rise clearly above it
const MIN_TALK_MS = 300 // a cough or a door isn't a turn
const BARGE_IN_MS = 250 // this much of your voice over the teammate's interrupts it
const SILENCE_MS = 1000 // this long quiet after talking ends your turn
const MAX_TURN_MS = 60_000

// Module constant: useAudioRecorder recreates (and releases) the recorder whenever its options object changes.
// `voice_communication` turns on Android's echo cancellation, so the mic can stay open while the teammate speaks.
const RECORDING = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
  android: { ...RecordingPresets.HIGH_QUALITY.android, audioSource: 'voice_communication' as const },
}

/** dBFS → the 0–1 level the turn detection uses. */
const toLevel = (db?: number) => (db === undefined ? 0 : Math.max(0, Math.min(1, (db + 55) / 45)))
/** dBFS → the raw level voice-glow's driver expects (RMS × its base gain 5 × default sensitivity 3.1). */
const toBeam = (db?: number) => (db === undefined ? 0 : Math.min(1, Math.pow(10, db / 20) * 15.5))
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
 * Hands-free conversation, like Claude's voice mode: just talk; a pause ends your turn, the reply is spoken
 * sentence by sentence, and talking over it (or tapping) interrupts. The mic stays open throughout.
 */
export function VoiceMode({ teammate, title, messages, live, onSend, onClose }: VoiceModeProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const recorder = useAudioRecorder(RECORDING)
  const rec = useAudioRecorderState(recorder, 80)
  const beamLevel = useSharedValue(0)
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

  /** A fresh recording with the turn detection recalibrated; monitored as `listening`, or `speaking` for barge-in. */
  const record = async (then: 'listening' | 'speaking') => {
    if (closed.current) return
    try {
      if (recorder.isRecording) await recorder.stop()
      if (closed.current) return
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: false })
      await recorder.prepareToRecordAsync()
      if (closed.current) return
      recorder.record()
      const now = Date.now()
      turn.current = { ...turn.current, startedAt: now, spoke: false, lastLoud: 0, floor: 0, loudMs: 0, lastTick: now }
      if (then === 'listening') { setNote(''); go('listening') }
    } catch (e) {
      setNote(`The microphone is busy. Tap to try again.${__DEV__ ? ` (${(e as Error).message})` : ''}`)
      go('stopped')
    }
  }
  const listen = () => { stopPlayers(); return record('listening') }

  const endTurn = async () => {
    if (phaseRef.current !== 'listening' || closed.current) return
    go('transcribing')
    beamLevel.set(0)
    try {
      await recorder.stop()
      if (closed.current) return
      const uri = recorder.uri
      if (!uri) throw new Error('No recording')
      const audio = await (await fetch(uri)).arrayBuffer()
      const { text } = await api<{ text: string }>('/voice/transcribe', { method: 'POST', body: audio, headers: { 'Content-Type': 'audio/m4a' } })
      if (!text.trim()) return listen()
      setCaption(text)
      turn.current = { ...turn.current, sent: text, sawLive: false }
      go('thinking')
      await onSend(text)
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Couldn’t hear that. Tap to try again.')
      go('stopped')
    }
  }

  /** You talked over the reply: stop it and keep this recording going as your new turn. */
  const bargeIn = () => {
    haptic.light()
    stopPlayers()
    const now = Date.now()
    turn.current = { ...turn.current, startedAt: now, spoke: true, lastLoud: now }
    setNote('')
    go('listening')
  }

  const speak = async (m: ChatMessage) => {
    go('speaking')
    setCaption(plain(m.text))
    try {
      const [{ parts }, headers] = await Promise.all([api<{ parts: number }>(`/voice/messages/${m.id}`), authHeaders()])
      if (parts === 0) return listen()
      await record('speaking') // mic open for barge-in; echo cancellation keeps the reply out of it
      const load = (k: number) => createAudioPlayer({ uri: `${BASE}/voice/messages/${m.id}/${k}`, headers })
      const play = (k: number, player: AudioPlayer) => {
        if (phaseRef.current !== 'speaking' || closed.current) { player.remove(); return }
        // Fetch the next part while this one plays, so there's no gap between sentences.
        const next = k + 1 < parts ? load(k + 1) : null
        players.current = next ? [player, next] : [player]
        const sub = player.addListener('playbackStatusUpdate', (s) => {
          if (!s.didJustFinish) return
          sub.remove()
          player.remove()
          if (next) play(k + 1, next)
          else if (phaseRef.current === 'speaking') listen() // a fresh recording, without the reply in it
        })
        player.play()
      }
      play(0, load(0))
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Couldn’t play the reply. It’s in the chat.')
      go('stopped')
    }
  }

  // Start on open; release everything on close.
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
      // No recorder calls here: useAudioRecorder has already released it (and stopped it), and touching a
      // released recorder throws natively, which closed the app.
      setAudioModeAsync({ allowsRecording: false }).catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The mic: drives the glow while you talk, ends your turn on a pause, and interrupts the reply if you talk over it.
  useEffect(() => {
    const p = phaseRef.current
    if (p !== 'listening' && p !== 'speaking') return
    const l = toLevel(rec.metering)
    if (p === 'listening') beamLevel.set(toBeam(rec.metering))
    const now = Date.now()
    const t = turn.current
    const dt = now - t.lastTick
    t.lastTick = now
    if (now - t.startedAt < CALIBRATE_MS) { t.floor = Math.max(t.floor, l); return }
    const loud = l > Math.max(SPEECH, t.floor + (p === 'speaking' ? 0.25 : 0.18))
    if (loud) { t.lastLoud = now; t.loudMs += dt } else if (p === 'speaking') t.loudMs = Math.max(0, t.loudMs - dt)
    if (p === 'speaking') { if (t.loudMs >= BARGE_IN_MS) bargeIn(); return }
    if (t.loudMs >= MIN_TALK_MS) t.spoke = true
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
    const p = phaseRef.current
    if (p === 'speaking') { haptic.tap(); listen() } // interrupt
    else if (p === 'stopped') listen()
  }

  const toggleMute = async () => {
    haptic.tap()
    if (phaseRef.current === 'muted') return listen()
    stopPlayers()
    go('muted')
    beamLevel.set(0)
    try { if (recorder.isRecording) await recorder.stop() } catch {}
  }

  const label = {
    starting: 'Starting…',
    listening: 'Listening',
    transcribing: 'Listening',
    thinking: `${teammate?.name ?? title} is thinking`,
    speaking: 'Talk or tap to interrupt',
    muted: 'Microphone off',
    stopped: 'Paused',
  }[phase]
  const beam: VoiceBeamMode = phase === 'listening' ? 'listening' : phase === 'speaking' ? 'speaking'
    : phase === 'thinking' || phase === 'transcribing' ? 'processing' : 'idle'

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast)}
      exiting={FadeOut.duration(motion.duration.quick)}
      style={[StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? '#000' : c.canvas, zIndex: 20 }]}
      accessibilityViewIsModal
    >
      <VoiceBeam mode={beam} level={beamLevel} theme={scheme} />

      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {teammate && <TeammateAvatar teammate={teammate} size={28} state={phase === 'thinking' ? 'working' : 'default'} live interactive={false} />}
        <Text variant="headline" numberOfLines={1}>{title}</Text>
      </View>

      <Pressable onPress={tap} style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 140 }} accessibilityRole="button" accessibilityLabel={label}>
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

      <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
        <IconButton icon={KeyboardIcon} variant="soft" size={56} iconSize={22} round accessibilityLabel="Type instead" onPress={close} />
        <IconButton
          icon={phase === 'muted' ? MicOff01Icon : Mic01Icon}
          swapKey={phase === 'muted' ? 'off' : 'on'}
          variant={phase === 'muted' ? 'solid' : 'soft'}
          size={56}
          iconSize={22}
          round
          accessibilityLabel={phase === 'muted' ? 'Turn microphone on' : 'Mute microphone'}
          onPress={toggleMute}
        />
        <IconButton icon={Cancel01Icon} variant="soft" size={56} iconSize={22} round accessibilityLabel="End voice mode" onPress={close} />
      </View>
    </Animated.View>
  )
}
