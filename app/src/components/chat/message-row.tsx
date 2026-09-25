import * as Clipboard from 'expo-clipboard'
import { Image } from 'expo-image'
import { createContext, memo, useContext, useEffect, useState } from 'react'
import { Pressable, View, type ViewStyle } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import {
  Alert02Icon, ArrowDown01Icon, ArrowRight02Icon, ArrowTurnBackwardIcon, Copy01Icon, File01Icon, FlashIcon, Refresh01Icon,
} from '@hugeicons/core-free-icons'

import { ApprovalCard } from '@/components/approval-card'
import { fullTime, stripCues } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import type { Approval, Attachment, Teammate } from '@/lib/types'
import type { ChatMessage, Ghost, LiveStatus } from '@/lib/use-thread'
import { useTeammate } from '@/lib/workspace'
import { motion, radius, useTheme } from '@/theme'
import {
  Button, Collapse, Icon, Markdown, Press, Squircle, TeammateAvatar, Text, ThinkingIndicator, haptic, showMenu, toast, useFlip,
} from '@/ui'

import { ConnectCard, QuestionCard } from './prompt-cards'
import { SwipeToReply } from './swipe-reply'

export type ChatItem =
  | { type: 'message'; key: string; m: ChatMessage }
  | { type: 'ghost'; key: string; g: Ghost }
  | { type: 'status'; key: string; s: LiveStatus }

export const AVATAR = 28
export const GUTTER = AVATAR + 10
const R = 20 // bubble radius
const JOIN = 6 // corner between two bubbles of one group

export function senderOf(item: ChatItem) {
  if (item.type === 'message') {
    const m = item.m
    if (m.kind === 'handoff' || m.kind === 'event' || m.kind === 'error') return 'system'
    return m.sender_type === 'teammate' ? `tm:${m.teammate_id}` : m.sender_type
  }
  return `tm:${item.type === 'ghost' ? item.g.teammate_id : item.s.teammate_id}`
}
export const timeOf = (item: ChatItem) => (item.type === 'message' ? item.m.created_at : new Date().toISOString())

/** Thread-wide handlers, kept stable by the screen so rows only re-render when their own data changes. */
export interface ChatActions {
  onReply: (m: ChatMessage) => void
  jumpTo: (id: string) => void
  onRetryMessage: (m: ChatMessage) => void
  onDiscardMessage: (m: ChatMessage) => void
  onRetryRun: () => void
  onDecided: () => void
  handles: Set<string>
}
export const ChatActionsContext = createContext<ChatActions | null>(null)
const useActions = () => useContext(ChatActionsContext)!

export interface ChatRowProps {
  item: ChatItem
  firstInGroup: boolean
  lastInGroup: boolean
  dayBreak: string | null
  /** Freeze avatars far up the thread. */
  pauseAvatar: boolean
  approval?: Approval
  /** The message this one replies to; `null` when it isn't loaded. */
  replyTo?: ChatMessage | null
  highlighted?: boolean
  /** This row's teammate is running right now (animates its avatar). */
  working?: boolean
  /** The live run was started by an event or schedule. */
  proactive?: boolean
}

const payload = (i: ChatItem) => (i.type === 'message' ? i.m : i.type === 'ghost' ? i.g : `${i.s.run_id}|${i.s.state}|${i.s.label ?? ''}`)

/** Memoised on the row's own data: a streaming delta re-renders one row, not the whole list. */
export const ChatRow = memo(function ChatRow(p: ChatRowProps) {
  return (
    <View style={{ paddingHorizontal: 12 }}>
      {p.dayBreak && <DaySeparator label={p.dayBreak} />}
      <Body {...p} />
    </View>
  )
}, (a, b) => payload(a.item) === payload(b.item) && a.firstInGroup === b.firstInGroup && a.lastInGroup === b.lastInGroup
  && a.dayBreak === b.dayBreak && a.pauseAvatar === b.pauseAvatar && a.approval === b.approval && a.replyTo === b.replyTo
  && a.highlighted === b.highlighted && a.working === b.working && a.proactive === b.proactive)

function DaySeparator({ label }: { label: string }) {
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 8 }} accessibilityRole="header">
      <Text variant="footnote" color="ink3">{label}</Text>
    </View>
  )
}

function Body({ item, firstInGroup: first, lastInGroup: last, pauseAvatar, approval, replyTo, highlighted, working, proactive }: ChatRowProps) {
  const actions = useActions()
  const t = useTeammate(item.type === 'status' ? item.s.teammate_id : item.type === 'ghost' ? item.g.teammate_id : item.m.teammate_id)
  if (item.type === 'status') {
    return (
      <TeammateBlock teammate={t} first={first} paused={false} working>
        <Bubble side="left" first={first} last={last} style={{ paddingVertical: 10 }}>
          <ThinkingIndicator state={item.s.state} label={item.s.label} />
        </Bubble>
      </TeammateBlock>
    )
  }
  if (item.type === 'ghost') {
    return (
      <TeammateBlock teammate={t} first={first} paused={false} working>
        {/* Same label and bubble the final row carries, so the swap doesn't shift anything. */}
        {proactive && <EventLabel />}
        <Bubble side="left" first={first} last={last}>
          <View accessibilityLiveRegion="none"><Markdown value={stripCues(item.g.text)} /></View>
        </Bubble>
      </TeammateBlock>
    )
  }
  const m = item.m
  switch (m.kind) {
    case 'handoff': return <HandoffRow m={m} />
    case 'event': return <SystemRow icon={FlashIcon} text={m.text || `Event: ${String(m.meta.event_type ?? 'external')}`} />
    case 'error': return <ErrorRow m={m} onRetry={actions.onRetryRun} />
    case 'approval':
    case 'question':
    case 'connect': {
      return (
        <TeammateBlock teammate={t} first={first} paused={pauseAvatar} working={working}>
          {/* The card carries the whole ask; the row's text only shows until the approval row loads. */}
          {!approval ? (
            <Bubble side="left" first={first} last={last}><Text color="ink2">{m.text || 'Loading…'}</Text></Bubble>
          ) : m.kind === 'question' ? (
            <QuestionCard approval={approval} onDecided={actions.onDecided} />
          ) : m.kind === 'connect' ? (
            <ConnectCard approval={approval} onDecided={actions.onDecided} />
          ) : (
            <ApprovalCard approval={approval} teammate={t} beam={approval.status === 'pending'} onDecided={actions.onDecided} />
          )}
        </TeammateBlock>
      )
    }
    default:
      return m.sender_type === 'user'
        ? <UserMessage m={m} first={first} last={last} replyTo={replyTo} highlighted={highlighted} />
        : <TeammateMessage m={m} teammate={t} first={first} last={last} paused={pauseAvatar} working={working} replyTo={replyTo} highlighted={highlighted} />
  }
}

/** Squircle bubble. Corners on the sender's side tighten where it meets the next bubble in its group. */
function Bubble({ side, first, last, tone = 'panel', highlighted, style, children }: {
  side: 'left' | 'right'; first: boolean; last: boolean; tone?: 'panel' | 'mine'; highlighted?: boolean; style?: ViewStyle; children: React.ReactNode
}) {
  const { c, scheme } = useTheme()
  const top = first ? R : JOIN
  const bottom = last ? R : JOIN
  const corners = side === 'left'
    ? { borderTopLeftRadius: top, borderBottomLeftRadius: bottom, borderTopRightRadius: R, borderBottomRightRadius: R }
    : { borderTopRightRadius: top, borderBottomRightRadius: bottom, borderTopLeftRadius: R, borderBottomLeftRadius: R }
  // Yours: zinc-100 in light, one step above the teammate's bubble in dark.
  const bg = tone === 'panel' ? c.panel : scheme === 'dark' ? c.panel3 : c.panel2
  const bordered = tone === 'panel' && scheme === 'light'
  return (
    <Squircle style={[{
      ...corners, backgroundColor: bg, paddingHorizontal: 14, paddingVertical: 9, overflow: 'hidden',
      borderWidth: bordered ? 1 : 0, borderColor: c.line,
    }, style]}>
      {children}
      {highlighted && (
        <Animated.View
          pointerEvents="none"
          entering={FadeIn.duration(motion.duration.fast)}
          exiting={FadeOut.duration(motion.duration.slow)}
          style={{ position: 'absolute', inset: 0, backgroundColor: c.tubeSoft }}
        />
      )}
    </Squircle>
  )
}

function TeammateBlock({ teammate, first, paused, working, children }: {
  teammate?: Teammate; first: boolean; paused: boolean; working?: boolean; children: React.ReactNode
}) {
  const live = !!working
  return (
    <View style={{ marginTop: first ? 14 : 2 }}>
      {first && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          {teammate ? <TeammateAvatar teammate={teammate} size={AVATAR} state={live ? 'working' : 'default'} paused={paused && !live} /> : <View style={{ width: AVATAR }} />}
          <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
            {teammate?.name ?? 'Former teammate'}
            {teammate && <Text variant="footnote" color="ink3">{`  ${teammate.role}`}</Text>}
          </Text>
        </View>
      )}
      <View style={{ paddingLeft: GUTTER, paddingRight: 8, alignItems: 'flex-start' }}>{children}</View>
    </View>
  )
}

function messageMenu(m: ChatMessage, onReply?: (m: ChatMessage) => void) {
  showMenu({
    title: fullTime(m.created_at),
    items: [
      ...(onReply ? [{ label: 'Reply', icon: ArrowTurnBackwardIcon, onPress: () => onReply(m) }] : []),
      { label: 'Copy text', icon: Copy01Icon, onPress: async () => { await Clipboard.setStringAsync(m.text); toast({ title: 'Copied' }) } },
    ],
  })
}

function TeammateMessage({ m, teammate, first, last, paused, working, replyTo, highlighted }: {
  m: ChatMessage; teammate?: Teammate; first: boolean; last: boolean; paused: boolean; working?: boolean; replyTo?: ChatMessage | null; highlighted?: boolean
}) {
  const { onReply } = useActions()
  const calls = m.meta.tool_calls ?? []
  return (
    <SwipeToReply onReply={() => onReply(m)}>
      <TeammateBlock teammate={teammate} first={first} paused={paused} working={working}>
        {m.proactive && <EventLabel type={m.meta.event_type} />}
        <Pressable onLongPress={() => { haptic.light(); messageMenu(m, onReply) }} delayLongPress={350} accessibilityHint="Long press to reply or copy" style={{ maxWidth: '100%' }}>
          <Bubble side="left" first={first} last={last} highlighted={highlighted}>
            {m.reply_to && <ReplyQuote id={m.reply_to} target={replyTo} />}
            <Markdown value={stripCues(m.text)} />
            <Attachments items={m.meta.attachments} />
          </Bubble>
        </Pressable>
        {calls.length > 0 && <ToolCalls calls={calls} />}
      </TeammateBlock>
    </SwipeToReply>
  )
}

function UserMessage({ m, first, last, replyTo, highlighted }: {
  m: ChatMessage; first: boolean; last: boolean; replyTo?: ChatMessage | null; highlighted?: boolean
}) {
  const { onReply, onRetryMessage, onDiscardMessage, handles } = useActions()
  return (
    <SwipeToReply onReply={() => onReply(m)} enabled={!m.local}>
      <View style={{ alignItems: 'flex-end', marginTop: first ? 14 : 2 }}>
        <Pressable
          onLongPress={() => { haptic.light(); messageMenu(m, m.local ? undefined : onReply) }}
          delayLongPress={350}
          style={{ maxWidth: '82%' }}
          accessibilityLabel={`You: ${m.text}${m.local === 'failed' ? '. Not sent' : ''}`}
        >
          <Bubble side="right" first={first} last={last} tone="mine" highlighted={highlighted} style={{ opacity: m.local === 'sending' ? 0.6 : 1 }}>
            {m.reply_to && <ReplyQuote id={m.reply_to} target={replyTo} />}
            <Attachments items={m.meta.attachments} />
            {!!m.text && <Text selectable>{renderMentions(m.text, handles)}</Text>}
          </Bubble>
        </Pressable>
        {m.local === 'failed' && (
          <Animated.View entering={FadeIn.duration(motion.duration.quick)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <Icon icon={Alert02Icon} size={14} color="danger" />
            <Text variant="footnote" color="danger">Not sent</Text>
            <Press radius={8} static onPress={() => { haptic.light(); onRetryMessage(m) }} style={{ paddingHorizontal: 8, minHeight: 32, justifyContent: 'center' }}>
              <Text variant="label" color="ink">Retry</Text>
            </Press>
            <Press radius={8} static onPress={() => onDiscardMessage(m)} style={{ paddingHorizontal: 8, minHeight: 32, justifyContent: 'center' }}>
              <Text variant="label" color="ink3">Delete</Text>
            </Press>
          </Animated.View>
        )}
      </View>
    </SwipeToReply>
  )
}

/** Who a message is from, for quotes and the composer's reply bar. */
export function useSenderName(m?: ChatMessage | null) {
  const t = useTeammate(m?.teammate_id)
  if (!m) return ''
  return m.sender_type === 'user' ? 'You' : t?.name ?? 'Teammate'
}

/** Quoted message at the top of a reply bubble; tap to jump to it. */
function ReplyQuote({ id, target }: { id: string; target?: ChatMessage | null }) {
  const { c } = useTheme()
  const { jumpTo } = useActions()
  const name = useSenderName(target)
  const preview = target ? target.text.replace(/\s+/g, ' ').trim() || (target.meta.attachments?.length ? 'Attachment' : '') : 'Earlier message'
  return (
    <Pressable
      onPress={() => target && jumpTo(id)}
      accessibilityRole="button"
      accessibilityLabel={`Replying to ${name || 'an earlier message'}: ${preview}`}
      style={{ marginHorizontal: -6, marginTop: -2, marginBottom: 6 }}
    >
      <Squircle style={{ borderRadius: 12, backgroundColor: c.wash, flexDirection: 'row', overflow: 'hidden' }}>
        <View style={{ width: 3, backgroundColor: c.tube }} />
        <View style={{ paddingHorizontal: 9, paddingVertical: 6, flexShrink: 1 }}>
          {!!name && <Text variant="footnote" color="tube" numberOfLines={1} style={{ fontWeight: '600' }}>{name}</Text>}
          <Text variant="footnote" color="ink2" numberOfLines={2}>{preview}</Text>
        </View>
      </Squircle>
    </Pressable>
  )
}

const signed = new Map<string, string>()
function useSignedUrl(path: string) {
  const [url, setUrl] = useState(signed.get(path))
  useEffect(() => {
    if (url) return
    let on = true
    supabase.storage.from('attachments').createSignedUrl(path, 60 * 60 * 24).then(({ data }) => {
      if (data?.signedUrl && on) { signed.set(path, data.signedUrl); setUrl(data.signedUrl) }
    })
    return () => { on = false }
  }, [path, url])
  return url
}

function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
}

function Attachments({ items }: { items?: Attachment[] }) {
  if (!items?.length) return null
  const images = items.filter((a) => a.mime.startsWith('image/'))
  const files = items.filter((a) => !a.mime.startsWith('image/'))
  return (
    <View style={{ gap: 6, marginHorizontal: -8, marginTop: -3, marginBottom: 6 }}>
      {images.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
          {images.map((a) => <ImageThumb key={a.path} a={a} single={images.length === 1} />)}
        </View>
      )}
      {files.map((a) => <FileChip key={a.path} a={a} />)}
    </View>
  )
}

function ImageThumb({ a, single }: { a: Attachment; single: boolean }) {
  const { c } = useTheme()
  const url = useSignedUrl(a.path)
  const ratio = a.width && a.height ? a.width / a.height : 4 / 3
  const w = single ? 240 : 118
  return (
    <Squircle style={{ width: w, height: single ? Math.min(w / ratio, 320) : w, borderRadius: 14, overflow: 'hidden', backgroundColor: c.panel3 }}>
      {url && <Image source={url} style={{ flex: 1 }} contentFit="cover" transition={motion.duration.fast} accessibilityLabel={a.name} />}
    </Squircle>
  )
}

function FileChip({ a }: { a: Attachment }) {
  const { c } = useTheme()
  const ext = a.name.split('.').pop()?.toUpperCase().slice(0, 4) ?? ''
  return (
    <Squircle style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, backgroundColor: c.wash, padding: 8, paddingRight: 12, minWidth: 180 }}>
      <Squircle style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: c.panel, alignItems: 'center', justifyContent: 'center' }}>
        <Icon icon={File01Icon} size={18} color="ink2" />
      </Squircle>
      <View style={{ flexShrink: 1 }}>
        <Text variant="label" numberOfLines={1}>{a.name}</Text>
        <Text variant="footnote" color="ink3">{[ext, formatSize(a.size)].filter(Boolean).join(' · ')}</Text>
      </View>
    </Squircle>
  )
}

function EventLabel({ type }: { type?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 }}>
      <Icon icon={FlashIcon} size={13} color="ink3" />
      <Text variant="footnote" color="ink3" numberOfLines={1}>Started by an event{type ? `: ${type}` : ''}</Text>
    </View>
  )
}

/** Accordion (transitions.dev 21) listing the tools a reply used. */
function ToolCalls({ calls }: { calls: { name: string; status: string }[] }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const flip = useFlip(open)
  const label = calls.length === 1 ? 'Used 1 tool' : `Used ${calls.length} tools`
  return (
    <View style={{ marginTop: 4, alignSelf: 'stretch' }}>
      <Press
        radius={8}
        static
        onPress={() => setOpen((o) => !o)}
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        outerStyle={{ alignSelf: 'flex-start' }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, minHeight: 32 }}
      >
        <Text variant="footnote" color="ink3">{label}</Text>
        <Animated.View style={flip}><Icon icon={ArrowDown01Icon} size={14} color="ink3" /></Animated.View>
      </Press>
      <Collapse open={open}>
        <View style={{ gap: 4, paddingBottom: 4, paddingHorizontal: 6 }}>
          {calls.map((call, i) => (
            <View key={`${call.name}-${i}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: call.status === 'error' ? c.danger : c.ink3 }} />
              <Text variant="footnote" color="ink2" numberOfLines={1} style={{ flex: 1 }}>{call.name}</Text>
              <Text variant="footnote" color={call.status === 'error' ? 'danger' : 'ink3'}>{call.status}</Text>
            </View>
          ))}
        </View>
      </Collapse>
    </View>
  )
}

function renderMentions(text: string, handles: Set<string>) {
  return text.split(/(@[a-z0-9][a-z0-9_-]*)/gi).map((part, i) =>
    part.startsWith('@') && handles.has(part.slice(1).toLowerCase())
      ? <Text key={i} variant="bodyMedium" color="tube">{part}</Text>
      : part)
}

function HandoffRow({ m }: { m: ChatMessage }) {
  const from = useTeammate(m.teammate_id)
  const to = useTeammate(m.meta.to_teammate_id)
  const note = m.meta.note
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 16 }}
      accessible
      accessibilityLabel={`${from?.name ?? 'A teammate'} handed off to ${to?.name ?? 'a teammate'}${note ? `: ${note}` : ''}`}
    >
      {from && <TeammateAvatar teammate={from} size={18} interactive={false} paused />}
      <Text variant="footnote" color="ink2">{from?.name ?? 'Teammate'}</Text>
      <Icon icon={ArrowRight02Icon} size={13} color="ink3" />
      {to && <TeammateAvatar teammate={to} size={18} interactive={false} paused />}
      <Text variant="footnote" color="ink2">{to?.name ?? 'Teammate'}</Text>
      {note ? <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flexShrink: 1 }}>{` · “${note}”`}</Text> : null}
    </View>
  )
}

function SystemRow({ icon, text }: { icon: typeof FlashIcon; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 16 }}>
      <Icon icon={icon} size={14} color="ink3" />
      <Text variant="footnote" color="ink3" numberOfLines={2} style={{ flexShrink: 1 }}>{text}</Text>
    </View>
  )
}

function ErrorRow({ m, onRetry }: { m: ChatMessage; onRetry: () => void }) {
  const { c } = useTheme()
  return (
    <Squircle style={{ marginTop: 10, marginLeft: GUTTER, borderRadius: radius.md, backgroundColor: c.dangerSoft, paddingLeft: 12, paddingRight: 4, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon icon={Alert02Icon} size={16} color="danger" />
      <Text variant="caption" color="ink2" style={{ flex: 1, paddingVertical: 6 }}>{m.text || 'The run stopped with an error.'}</Text>
      <Button label="Retry" size="sm" variant="ghost" icon={Refresh01Icon} onPress={onRetry} />
    </Squircle>
  )
}
