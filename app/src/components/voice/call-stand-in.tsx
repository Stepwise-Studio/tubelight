// The call stand-in (agent calls.py, phone Calls.kt): someone rang, the user tapped "let my assistant answer". This
// answers, puts the call on speaker, and lets Gemini Live talk to the caller as the user's assistant, with what
// Tubelight knows about them: "how's my thing going" is looked up (check_progress), anything else becomes a message.
// The user can take over or hang up at any time; when the call ends, the server files the summary, to-dos and a note.
import MaskedView from '@react-native-masked-view/masked-view'
import { LinearGradient as Fade } from 'expo-linear-gradient'
import { useEffect, useRef, useState } from 'react'
import { FlatList, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Call02Icon, CallEnd01Icon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { LIVE_WS, frameText } from '@/lib/live'
import { Phone } from '@/lib/phone'
import { useTheme } from '@/theme'
import { Button, Text, TextSwap, haptic } from '@/ui'

import { LiveAudio } from '../../../modules/live-audio'

type Line = { key: string; caller: boolean; text: string }
type Phase = 'answering' | 'talking' | 'filing' | 'error'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function CallStandIn({ caller, onDone }: { caller: string; onDone: () => void }) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const dark = scheme === 'dark'
  const [phase, setPhase] = useState<Phase>('answering')
  const [error, setError] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [live, setLive] = useState<Line | null>(null)
  const stop = useRef<(how: 'ended' | 'takeover' | 'hangup') => void>(() => {})

  useEffect(() => {
    let done = false
    let sock: WebSocket | null = null
    let id = ''
    let n = 0
    const turns: { role: 'user' | 'teammate'; text: string }[] = []
    let cur = { caller: '', me: '' }
    const subs: { remove(): void }[] = []
    const timers: ReturnType<typeof setInterval>[] = []
    const send = (m: object) => { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m)) }
    const keep = (isCaller: boolean, text: string) => {
      if (!text.trim()) return
      turns.push({ role: isCaller ? 'user' : 'teammate', text: text.trim() })
      setLines((l) => [{ key: String(n++), caller: isCaller, text: text.trim() }, ...l])
    }
    const flushCaller = () => { if (cur.caller.trim()) { keep(true, cur.caller); cur.caller = ''; setLive(null) } }

    const finish = async (how: 'ended' | 'takeover' | 'hangup') => {
      if (done) return
      done = true
      flushCaller(); keep(false, cur.me); cur = { caller: '', me: '' }
      timers.forEach(clearInterval); subs.forEach((s) => s.remove())
      try { sock?.close() } catch {}
      LiveAudio.stop()
      if (how === 'hangup') { try { Phone?.callHangUp() } catch {} }
      if (how === 'takeover') { try { Phone?.callSpeaker(false) } catch {} }
      try { Phone?.standInAccess(false) } catch {}
      setPhase('filing')
      if (id) await api(`/calls/${id}/end`, { method: 'POST', json: { turns } }).catch(() => {})
      onDone()
    }
    stop.current = (how) => { void finish(how) }

    ;(async () => {
      try {
        if (!Phone) throw new Error('Update Tubelight to answer calls.')
        const r = await api<{ call_id: string; token: string }>('/calls/start', { method: 'POST', json: { caller } })
        id = r.call_id
        if (!Phone.standInAccess(true)) throw new Error('To hear the caller, Tubelight needs its one-time setup (Profile → Phone assistant → Answer calls for me).')
        if (Phone.callState() === 'ringing') Phone.callAnswer()
        for (let i = 0; i < 25 && Phone.callState() !== 'active'; i++) await wait(200)
        if (Phone.callState() !== 'active') throw new Error('The call ended before it could be answered.')
        Phone.callSpeaker(true)
        sock = new WebSocket(`${LIVE_WS}?access_token=${encodeURIComponent(r.token)}`)
        sock.binaryType = 'arraybuffer'
        sock.onopen = () => sock?.send(JSON.stringify({ setup: {} }))
        sock.onclose = () => { if (!done) void finish('ended') }
        sock.onmessage = async (e) => {
          const m = JSON.parse(frameText(e.data))
          if (m.setupComplete) {
            await LiveAudio.start(true)
            setPhase('talking')
            haptic.light()
            // The caller is waiting on the line: greet them first.
            send({ clientContent: { turnComplete: true, turns: [{ role: 'user', parts: [{ text: '(The call is connected. Greet the caller now.)' }] }] } })
            return
          }
          if (m.toolCall) {
            flushCaller()
            for (const fc of m.toolCall.functionCalls ?? []) {
              const path = fc.name === 'check_progress' ? 'ask' : 'message'
              const json = fc.name === 'check_progress' ? { question: String(fc.args?.question ?? '') }
                : { message: String(fc.args?.message ?? ''), urgent: !!fc.args?.urgent }
              const res = await api<{ answer: string }>(`/calls/${id}/${path}`, { method: 'POST', json }).catch(() => ({ answer: 'Not available right now: take a message.' }))
              send({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: res.answer } }] } })
            }
            return
          }
          const sc = m.serverContent
          if (!sc) return
          if (sc.interrupted) LiveAudio.clear()
          for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) { flushCaller(); LiveAudio.play(p.inlineData.data) }
          if (sc.inputTranscription?.text) { cur.caller += sc.inputTranscription.text; setLive({ key: 'live', caller: true, text: cur.caller.trim() }) }
          if (sc.outputTranscription?.text) { flushCaller(); cur.me += sc.outputTranscription.text; setLive({ key: 'live', caller: false, text: cur.me.trim() }) }
          if (sc.turnComplete) { flushCaller(); keep(false, cur.me); cur.me = ''; setLive(null) }
        }
        subs.push(LiveAudio.addListener('onMic', ({ data }) => send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } })))
        // The caller hangs up: wrap up.
        timers.push(setInterval(() => { if (Phone?.callState() === 'idle') void finish('ended') }, 1000))
      } catch (e) {
        setError((e as Error).message)
        setPhase('error')
        try { Phone?.standInAccess(false) } catch {}
        if (id) api(`/calls/${id}/end`, { method: 'POST', json: { turns } }).catch(() => {})
      }
    })()
    return () => { void finish('ended') }
  }, [caller]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = live ? [live, ...lines] : lines
  const ink = dark ? '#fff' : c.ink
  const label = phase === 'answering' ? `Answering ${caller}…` : phase === 'talking' ? `Your assistant is talking to ${caller}`
    : phase === 'filing' ? 'Writing up the call…' : error
  return (
    <View style={{ height: '80%' }} accessibilityViewIsModal>
      <View style={{ alignItems: 'center', gap: 4, paddingHorizontal: 24 }}>
        <Text variant="headline" color={ink} numberOfLines={1}>{caller}</Text>
        <TextSwap variant="label" color={dark ? 'rgba(255,255,255,0.6)' : 'ink3'}>{label}</TextSwap>
      </View>
      <MaskedView style={{ flex: 1 }} maskElement={<Fade colors={['transparent', '#000']} locations={[0, 0.2]} style={{ flex: 1 }} />}>
        <FlatList inverted style={{ flex: 1 }} data={shown} keyExtractor={(l) => l.key} showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 28, paddingBottom: 24 }}
          renderItem={({ item: l, index }) => (
            <Text align="center" style={l.caller
              ? { fontSize: 17, lineHeight: 24, color: dark ? 'rgba(255,255,255,0.58)' : c.ink3, marginTop: index < shown.length - 1 ? 22 : 0 }
              : { fontSize: 21, lineHeight: 30, fontWeight: '500', color: ink, marginTop: 10 }}>
              {l.text}
            </Text>
          )}
        />
      </MaskedView>
      <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 24, paddingBottom: insets.bottom + 24 }}>
        {phase === 'error' ? <View style={{ flex: 1 }}><Button label="Close" variant="soft" fullWidth onPress={onDone} /></View> : (
          <>
            <View style={{ flex: 1 }}><Button label="Take over" icon={Call02Icon} variant="soft" fullWidth disabled={phase === 'filing'}
              onPress={() => { haptic.tap(); stop.current('takeover') }} /></View>
            <View style={{ flex: 1 }}><Button label="Hang up" icon={CallEnd01Icon} variant="destructive" fullWidth disabled={phase === 'filing'}
              onPress={() => { haptic.tap(); stop.current('hangup') }} /></View>
          </>
        )}
      </View>
    </View>
  )
}
