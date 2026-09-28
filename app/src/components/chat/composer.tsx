import { Image } from 'expo-image'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text as RNText, ScrollView, TextInput, View } from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { FadeIn, FadeOut, LinearTransition, interpolate, useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Add01Icon, Alert02Icon, ArrowTurnBackwardIcon, ArrowUp02Icon, Camera01Icon, Cancel01Icon, File01Icon, Image01Icon, Mic01Icon, StopIcon, UserGroupIcon,
} from '@hugeicons/core-free-icons'

import { pickDocuments, pickPhotos, takePhoto, upload, type Draft } from '@/lib/attachments'
import { useConnections } from '@/lib/catalog'
import { plainText } from '@/lib/format'
import { appToken, mentionParts, mentionsIn } from '@/lib/mentions'
import type { Attachment, Teammate } from '@/lib/types'
import type { ChatMessage, SendOptions } from '@/lib/use-thread'
import { motion, radius, type as typeScale, useTheme } from '@/theme'
import { Icon, IconButton, ListRow, Squircle, TeammateAvatar, Text, elevation, haptic, showMenu, toast } from '@/ui'

import { BottomEdge } from '@/components/bottom-edge'

import { Dictation } from './dictation'

import { useSenderName } from './message-row'

const MENTION = /(^|\s)@([a-z0-9_-]*)$/i
const MAX_FILES = 6
// Half the one-line height (36 button + 2×4 padding + 2×1 border): a capsule at rest, soft corners as it grows.
const PILL = 23

export interface ComposerProps {
  placeholder: string
  /** Project members for @mentions. Empty in DMs (no picker). */
  members: Teammate[]
  live: boolean
  onSend: (text: string, mentions: string[], opts: SendOptions) => void
  onStop: () => Promise<unknown> | void
  replyTo?: ChatMessage | null
  onCancelReply?: () => void
  /** Shows the mic while the input is empty. */
  onVoice?: () => void
}

type Item = Draft & { att?: Attachment }

/**
 * Floating bar over the chat: a pill with the reply strip and attachment tray on top, + for files, the input and one
 * trailing action (mic when empty, send when there's something, stop while a run is live). Behind it there's no solid
 * band: the chat fades into the canvas and blurs more toward the bottom edge.
 */
export function Composer({ placeholder, members, live, onSend, onStop, replyTo, onCancelReply, onVoice }: ComposerProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const kb = useReanimatedKeyboardAnimation()
  const input = useRef<TextInput>(null)
  const [text, setText] = useState('')
  const [dictating, setDictating] = useState(false)
  const [sel, setSel] = useState(0)
  const [stopping, setStopping] = useState(false)
  const [files, setFiles] = useState<Item[]>([])
  // At rest the bar sits in from the edges; typing widens it to the full width.
  const [focused, setFocused] = useState(false)

  useEffect(() => { if (replyTo) input.current?.focus() }, [replyTo])

  // Connected apps can be @mentioned too (DMs included): the teammate who answers gets that app for the request.
  const { connections } = useConnections()
  const apps = (connections ?? []).filter((a) => a.connected).map((a) => ({ ...a, token: appToken(a.toolkit) }))
  const known = new Set([...members.map((m) => m.handle.toLowerCase()), ...(members.length > 1 ? ['all', 'everyone'] : []), ...apps.map((a) => a.token)])

  const before = text.slice(0, sel)
  const query = members.length || apps.length ? before.match(MENTION)?.[2]?.toLowerCase() : undefined
  const matches = query === undefined ? [] : members.filter((m) => m.handle.startsWith(query) || m.name.toLowerCase().startsWith(query))
  const appMatches = query === undefined ? [] : apps.filter((a) => a.token.startsWith(query) || a.name.toLowerCase().startsWith(query))
  const offerAll = query !== undefined && members.length > 1 && ('all'.startsWith(query) || 'everyone'.startsWith(query))
  const people = matches
  const appRows = appMatches

  const pad = useAnimatedStyle(() => ({ paddingBottom: interpolate(kb.progress.value, [0, 1], [Math.max(insets.bottom, 10), 10]) }))

  const insert = (handle: string) => {
    haptic.tap()
    const start = before.replace(MENTION, (_m, space) => `${space}@${handle} `)
    setText(start + text.slice(sel))
    setSel(start.length)
  }

  const add = async (pick: () => Promise<Draft[]>) => {
    let picked: Draft[]
    try { picked = await pick() } catch (e) { return toast({ title: 'Unable to attach', body: (e as Error).message, tone: 'error' }) }
    const room = MAX_FILES - files.length
    if (picked.length > room) toast({ title: `Up to ${MAX_FILES} files per message` })
    const next = picked.slice(0, Math.max(room, 0))
    setFiles((f) => [...f, ...next])
    for (const d of next) {
      upload(d)
        .then((att) => setFiles((f) => f.map((x) => (x.id === d.id ? { ...x, att } : x))))
        .catch((e) => {
          setFiles((f) => f.map((x) => (x.id === d.id ? { ...x, failed: true } : x)))
          toast({ title: `Unable to upload ${d.name}`, body: (e as Error).message, tone: 'error' })
        })
    }
  }

  const attachMenu = () => showMenu({
    items: [
      { label: 'Photos', icon: Image01Icon, onPress: () => add(pickPhotos) },
      { label: 'Camera', icon: Camera01Icon, onPress: () => add(takePhoto) },
      { label: 'Document', icon: File01Icon, onPress: () => add(pickDocuments) },
    ],
  })

  const uploading = files.some((f) => !f.att && !f.failed)
  const ready = files.filter((f) => f.att).map((f) => f.att!)
  const canSend = (!!text.trim() || ready.length > 0) && !uploading
  const showStop = live && !text.trim() && !files.length
  const showMic = !showStop && !text.trim() && !files.length && !!onVoice

  const send = () => {
    if (!canSend) return
    const body = text.trim()
    haptic.light()
    const said = mentionsIn(body, known)
    const all = said.has('all') || said.has('everyone')
    const mentions = members.filter((m) => all || said.has(m.handle.toLowerCase())).map((m) => m.id)
    onSend(body, mentions, { attachments: ready, apps: apps.filter((a) => said.has(a.token)).map((a) => a.toolkit) })
    setText('')
    setSel(0)
    setFiles([])
  }

  const action = showStop
    ? { icon: StopIcon, key: 'stop', label: 'Stop the teammate', variant: 'solid' as const }
    : showMic
      ? { icon: Mic01Icon, key: 'mic', label: 'Voice mode', variant: 'soft' as const }
      : { icon: ArrowUp02Icon, key: 'send', label: 'Send', variant: canSend ? 'tube' as const : 'soft' as const }

  const field = (
    <Squircle cornerSmoothing={0} style={{ borderRadius: PILL, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
      {replyTo && <ReplyStrip m={replyTo} onCancel={onCancelReply} />}
      {files.length > 0 && (
        <Animated.View entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 10, paddingTop: 10 }} keyboardShouldPersistTaps="handled">
            {files.map((f) => <TrayItem key={f.id} f={f} onRemove={() => setFiles((all) => all.filter((x) => x.id !== f.id))} />)}
          </ScrollView>
        </Animated.View>
      )}
      {dictating ? (
        <Dictation
          onDone={(said) => {
            setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said))
            setDictating(false)
            setTimeout(() => input.current?.focus(), 50)
          }}
          onCancel={() => setDictating(false)}
        />
      ) : (
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: 4 }}>
        <IconButton icon={Add01Icon} round accessibilityLabel="Attach photos or files" size={36} iconSize={20} color={c.ink2} disabled={files.length >= MAX_FILES} onPress={attachMenu} />
        <TextInput
          ref={input}
          onChangeText={setText}
          onSelectionChange={(e) => setSel(e.nativeEvent.selection.end)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={c.ink4}
          selectionColor={c.tube}
          cursorColor={c.tube}
          keyboardAppearance={scheme}
          multiline
          accessibilityLabel={placeholder}
          style={[typeScale.body, { flex: 1, color: c.ink, minHeight: 36, maxHeight: 140, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 6, textAlignVertical: 'center' }]}
          maxFontSizeMultiplier={1.3}
        >
          {/* Finished @mentions tint as you type (the text itself stays plain: this only styles it). */}
          {mentionParts(text, known, false).map((part, i) => part.mention
            ? <RNText key={i} style={{ color: c.tube }}>{part.text}</RNText>
            : part.text)}
        </TextInput>
        <IconButton
          icon={action.icon}
          round
          swapKey={action.key}
          accessibilityLabel={action.label}
          variant={action.variant}
          size={36}
          iconSize={18}
          disabled={showStop ? stopping : showMic ? false : !canSend}
          // Tap: voice mode. Hold: dictate into the message box.
          onLongPress={showMic ? () => { haptic.medium(); setDictating(true) } : undefined}
          delayLongPress={350}
          accessibilityHint={showMic ? 'Hold to dictate instead' : undefined}
          onPress={async () => {
            if (showMic) { haptic.tap(); return onVoice?.() }
            if (!showStop) return send()
            haptic.medium()
            setStopping(true)
            await onStop()
            setStopping(false)
          }}
          style={{ marginLeft: 4 }}
        />
      </View>
      )}
    </Squircle>
  )

  return (
    <Animated.View style={[{ paddingHorizontal: focused ? 8 : 16, paddingTop: 10 }, pad]}>
      {/* Behind the bar: the chat fades out smoothly toward the bottom edge, clear at the top. */}
      <BottomEdge style={{ top: -36 }} />
      {(people.length > 0 || appRows.length > 0 || offerAll) && (
        <Animated.View
          entering={FadeIn.duration(motion.duration.fast)}
          exiting={FadeOut.duration(motion.duration.quick)}
          style={[{ position: 'absolute', left: 10, right: 10, bottom: '100%', borderRadius: radius.lg }, elevation(scheme, 2)]}
        >
          <Squircle style={{ borderRadius: radius.lg, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 4 }} accessibilityRole="menu">
            {/* Scrolls when there are many (all your apps); short enough to fit above the keyboard. */}
            <ScrollView style={{ maxHeight: 252 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {(offerAll || people.length > 0) && <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 2 }}>Teammates</Text>}
              {offerAll && (
                <ListRow
                  title="Everyone"
                  subtitle={`@all · all ${members.length} teammates reply`}
                  leading={
                    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon icon={UserGroupIcon} size={16} color={c.ink2} />
                    </View>
                  }
                  onPress={() => insert('all')}
                  style={{ minHeight: 48 }}
                />
              )}
              {people.map((m) => (
                <ListRow
                  key={m.id}
                  title={m.name}
                  subtitle={`@${m.handle} · ${m.role}`}
                  leading={<TeammateAvatar teammate={m} size={28} interactive={false} />}
                  onPress={() => insert(m.handle)}
                  style={{ minHeight: 48 }}
                />
              ))}
              {appRows.length > 0 && <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 2 }}>Apps</Text>}
              {appRows.map((a) => (
                <ListRow
                  key={a.toolkit}
                  title={a.name}
                  subtitle={`@${a.token} · connected app`}
                  leading={
                    <Squircle style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                      {a.logo ? <Image source={{ uri: a.logo }} style={{ width: 20, height: 20 }} contentFit="contain" /> : null}
                    </Squircle>
                  }
                  onPress={() => insert(a.token)}
                  style={{ minHeight: 48 }}
                />
              ))}
            </ScrollView>
          </Squircle>
        </Animated.View>
      )}
      <Animated.View layout={LinearTransition.duration(motion.duration.fast).easing(motion.ease.smoothOut)}>{field}</Animated.View>
    </Animated.View>
  )
}

function ReplyStrip({ m, onCancel }: { m: ChatMessage; onCancel?: () => void }) {
  const { c } = useTheme()
  const name = useSenderName(m)
  const preview = plainText(m.text) || (m.meta.attachments?.length ? 'Attachment' : '')
  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast)}
      exiting={FadeOut.duration(motion.duration.quick)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingRight: 4, paddingTop: 6 }}
    >
      <Icon icon={ArrowTurnBackwardIcon} size={16} color="tube" />
      <View style={{ flex: 1, minWidth: 0, borderLeftWidth: 2, borderLeftColor: c.tube, paddingLeft: 8 }}>
        <Text variant="footnote" color="tube" numberOfLines={1} style={{ fontWeight: '600' }}>{`Replying to ${name}`}</Text>
        <Text variant="footnote" color="ink2" numberOfLines={1}>{preview}</Text>
      </View>
      <IconButton icon={Cancel01Icon} accessibilityLabel="Cancel reply" size={32} iconSize={16} color={c.ink3} onPress={onCancel} />
    </Animated.View>
  )
}

function TrayItem({ f, onRemove }: { f: Item; onRemove: () => void }) {
  const { c } = useTheme()
  const image = f.mime.startsWith('image/')
  return (
    <View style={{ paddingTop: 6, paddingRight: 6 }}>
      <Squircle style={{ width: image ? 60 : 150, height: 60, borderRadius: 14, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: 'hidden', flexDirection: 'row', alignItems: 'center' }}>
        {image ? (
          <Image source={f.uri} style={{ width: 60, height: 60 }} contentFit="cover" accessibilityLabel={f.name} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, flex: 1 }}>
            <Icon icon={File01Icon} size={18} color="ink2" />
            <Text variant="footnote" numberOfLines={2} style={{ flex: 1 }}>{f.name}</Text>
          </View>
        )}
        {(!f.att || f.failed) && (
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' }}>
            {f.failed ? <Icon icon={Alert02Icon} size={18} color="#fff" /> : <ActivityIndicator size="small" color="#fff" />}
          </View>
        )}
      </Squircle>
      <IconButton
        icon={Cancel01Icon}
        accessibilityLabel={`Remove ${f.name}`}
        variant="solid"
        size={22}
        iconSize={12}
        onPress={onRemove}
        hitSlop={10}
        style={{ position: 'absolute', top: 0, right: 0 }}
      />
    </View>
  )
}
