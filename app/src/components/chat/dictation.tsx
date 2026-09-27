import { requestRecordingPermissionsAsync } from 'expo-audio'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated'
import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { LIVE_WS, frameText } from '@/lib/live'
import { motion, useTheme } from '@/theme'
import { IconButton, Text, haptic, toast } from '@/ui'

import { LiveAudio } from '../../../modules/live-audio'
import { Waveform, type WaveformHandle } from './waveform'

const SETTLE_MS = 600 // after ✓, wait this long past the last words for the final transcript
const MAX_WAIT_MS = 3000

/**
 * Dictation (long-press the mic): speak and your words appear, then ✓ puts them in the message box to edit or send.
 * Gemini's live transcription does the listening; the waveform follows your voice as you talk.
 */
export function Dictation({ onDone, onCancel }: { onDone: (text: string) => void; onCancel: () => void }) {
  const { c } = useTheme()
  const wave = useRef<WaveformHandle>(null)
  const ws = useRef<WebSocket | null>(null)
  const [text, setText] = useState('')
  const [state, setState] = useState<'starting' | 'listening' | 'finishing'>('starting')
  const heard = useRef({ text: '', at: 0 })
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    let cancelled = false
    const subs: { remove(): void }[] = []
    ;(async () => {
      const perm = await requestRecordingPermissionsAsync()
      if (!perm.granted) { toast({ title: 'Microphone needed', body: 'Allow the microphone to dictate.', tone: 'error' }); onCancel(); return }
      let token: string
      try {
        ({ token } = await api<{ token: string }>('/voice/dictate', { method: 'POST' }))
      } catch (e) {
        toast({ title: 'Unable to start dictation', body: (e as Error).message, tone: 'error' }); onCancel(); return
      }
      if (cancelled) return
      const sock = new WebSocket(`${LIVE_WS}?access_token=${encodeURIComponent(token)}`)
      sock.binaryType = 'arraybuffer'
      ws.current = sock
      sock.onopen = () => sock.send(JSON.stringify({ setup: {} }))
      sock.onmessage = (e) => {
        const m = JSON.parse(frameText(e.data))
        if (m.setupComplete) {
          LiveAudio.start().then(() => { if (!cancelled) { setState('listening'); haptic.light() } }, () => {
            toast({ title: 'The microphone is unavailable', tone: 'error' }); onCancel()
          })
        }
        const piece = m.serverContent?.inputTranscription?.text
        if (piece) {
          heard.current = { text: heard.current.text + piece, at: Date.now() }
          setText(heard.current.text.trim())
        }
      }
      sock.onclose = () => { if (!cancelled && ws.current === sock) ws.current = null }
      subs.push(
        LiveAudio.addListener('onMic', ({ data }) => {
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }))
        }),
        LiveAudio.addListener('onInputLevel', ({ level }) => wave.current?.push(level)),
      )
    })()
    return () => {
      cancelled = true
      subs.forEach((s) => s.remove())
      ws.current?.close()
      ws.current = null
      LiveAudio.stop()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ✓: end the audio, give the last words a moment to arrive, then hand the text over.
  const finish = () => {
    haptic.tap()
    setState('finishing')
    LiveAudio.setMuted(true)
    ws.current?.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
    const ended = Date.now()
    const poll = setInterval(() => {
      const { text: said, at } = heard.current
      const settled = at > ended && Date.now() - at > SETTLE_MS
      if (alive.current && !settled && Date.now() - ended < MAX_WAIT_MS) return
      clearInterval(poll)
      if (!alive.current) return
      if (said.trim()) onDone(said.trim())
      else { toast({ title: 'Didn’t catch that', body: 'Try again a little closer to the phone.' }); onCancel() }
    }, 100)
  }

  return (
    <View style={{ padding: 4 }}>
      {!!text && (
        <Animated.View entering={FadeIn.duration(motion.duration.fast)} layout={LinearTransition.duration(motion.duration.fast)}>
          <Text variant="body" numberOfLines={5} style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 }}>{text}</Text>
        </Animated.View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <IconButton icon={Cancel01Icon} round accessibilityLabel="Cancel dictation" size={36} iconSize={18} color={c.ink2} onPress={() => { haptic.tap(); onCancel() }} />
        <Waveform ref={wave} style={{ flex: 1, marginHorizontal: 8 }} />
        {state === 'starting' && <Text variant="caption" color="ink3" style={{ marginRight: 8 }}>Starting…</Text>}
        <IconButton
          icon={Tick02Icon}
          round
          variant="tube"
          size={36}
          iconSize={18}
          accessibilityLabel="Done dictating"
          disabled={state !== 'listening'}
          onPress={finish}
        />
      </View>
    </View>
  )
}
