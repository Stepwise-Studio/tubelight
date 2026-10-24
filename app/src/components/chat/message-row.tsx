import * as Clipboard from 'expo-clipboard'
import { router } from 'expo-router'
import { Image } from 'expo-image'
import { Fragment, createContext, memo, useContext, useEffect, useState } from 'react'
import { Linking, Pressable, View, useWindowDimensions, type ViewStyle } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import {
  Alert02Icon, Clock01Icon, ArrowDown01Icon, WorkflowIcon, UserIcon, ArrowTurnBackwardIcon, Copy01Icon, Download03Icon, FlashIcon, VaultIcon,
} from '@hugeicons/core-free-icons'

import { ApprovalCard } from '@/components/approval-card'
import { GenUI, drawable, drawing } from '@/components/genui/genui'
import { openAutomation, openAutomationOfRun } from '@/lib/automations'
import { copied, fullTime, plainText, stripCues } from '@/lib/format'
import { appToken, mentionParts } from '@/lib/mentions'
import { Phone, phoneLabel, runPhoneAction, type PhoneAction } from '@/lib/phone'
import { supabase } from '@/lib/supabase'
import type { Approval, Attachment, Teammate } from '@/lib/types'
import type { ChatMessage, Ghost, LiveStatus } from '@/lib/use-thread'
import { useTeammate } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import {
  Chip, Collapse, Icon, IconButton, ListRow, Markdown, Notice, Press, Sheet, Skeleton, Squircle, TeammateAvatar, Text, ThinkingIndicator, elevation, haptic,
  showEmojiPicker, showMenu, toast, useFlip, warmEmojis,
} from '@/ui'

import { Capsule, type Tone } from './capsule'
import { ImageViewer, saveImage } from './image-viewer'
import { FileTile } from '@/components/vault/file-tile'
import { FileIcon } from '@/components/vault/file-icon'
import { localCopy } from '@/components/vault/actions'
import { saveAttachment } from '@/lib/vault'
import { ConnectCard, QuestionCard, SigninCard } from './prompt-cards'
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
    if (m.kind === 'event' || m.kind === 'error') return 'system'
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
  onReact: (m: ChatMessage, emoji: string) => void
  handles: Set<string>
  /** Group chat (a project): name each teammate's replies. A DM needs no sender line. */
  group: boolean
  /** Sends a message as the user (a tapped choice in a drawing). */
  onSend: (text: string) => void
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
        <ThinkingIndicator state={item.s.state} label={item.s.label} />
      </TeammateBlock>
    )
  }
  if (item.type === 'ghost') {
    return (
      <TeammateBlock teammate={t} first={first} paused={false} working bleed={hasWideBlock(item.g.text)}>
        {/* Same label and layout the final row carries, so the swap doesn't shift anything. */}
        {proactive && item.g.event_type !== 'follow_up' && <Inset><EventLabel type={item.g.event_type} /></Inset>}
        <View accessibilityLiveRegion="none" style={{ alignSelf: 'stretch' }}><Reply text={item.g.text} first={first} last={last} /></View>
      </TeammateBlock>
    )
  }
  const m = item.m
  switch (m.kind) {
    case 'handoff': return <HandoffMessage m={m} first={first} last={last} paused={pauseAvatar} />
    case 'event': {
      // An automation's capsule opens it (unless it was deleted).
      const rule = m.meta.automation && m.meta.automation !== 'deleted' ? String(m.meta.rule_id ?? '') : ''
      return <Capsule text={m.text || `Event: ${String(m.meta.event_type ?? 'external')}`} tone={m.meta.automation ? AUTOMATION_TONE[String(m.meta.automation)] : FOLLOWUP_TONE[String(m.meta.followup)]}
        onPress={rule ? () => openAutomation(rule) : undefined} />
    }
    case 'error': return <ErrorRow m={m} onRetry={actions.onRetryRun} />
    case 'approval':
    case 'question':
    case 'connect':
    case 'signin': {
      return (
        <TeammateBlock teammate={t} first={first} paused={pauseAvatar} working={working} bleed>
          {/* The card carries the whole ask; the row's text only shows until the approval row loads.
              Cards span the chat's full width, like drawings (no reply-side inset). */}
          <View style={{ alignSelf: 'stretch' }}>
          {!approval ? (
            <Bubble side="left" first={first} last={last}><Text color="ink2">{m.text || 'Loading…'}</Text></Bubble>
          ) : m.kind === 'question' ? (
            <QuestionCard approval={approval} onDecided={actions.onDecided} />
          ) : m.kind === 'connect' ? (
            <ConnectCard approval={approval} onDecided={actions.onDecided} />
          ) : m.kind === 'signin' ? (
            <SigninCard approval={approval} onDecided={actions.onDecided} />
          ) : (
            <ApprovalCard approval={approval} teammate={t} beam={approval.status === 'pending'} onDecided={actions.onDecided} />
          )}
          </View>
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
/**
 * Code blocks and tables scroll sideways, and a bubble that shrink-wraps them gets mismeasured on Android (Yoga sizes
 * it at the block's full scroll width first, the text beside it wraps a letter per line, and the bubble ends up
 * thousands of pixels tall). Bubbles holding them take the full width instead.
 */
const hasWideBlock = (text: string) => splitWide(stripCues(text)).some((p) => p.wide)

/** Splits a reply into prose and wide blocks (fenced code, tables), in order. */
export function splitWide(text: string): { wide: boolean; text: string }[] {
  const out: { wide: boolean; text: string }[] = []
  let buf: string[] = []
  let mode: 'prose' | 'code' | 'table' = 'prose'
  const flush = () => {
    const t = buf.join('\n').trim()
    const d = mode === 'code' ? drawing(t) : null
    // A finished drawing that doesn't parse is left out, so the reply doesn't go full width around nothing.
    if (t && !(d && !d.open && !drawable(d.source))) out.push({ wide: mode !== 'prose', text: t })
    buf = []
  }
  for (const line of text.split('\n')) {
    if (mode === 'code') {
      buf.push(line)
      if (/^\s*```/.test(line)) { flush(); mode = 'prose' }
      continue
    }
    if (/^\s*```/.test(line)) { flush(); mode = 'code'; buf.push(line); continue }
    const row = /^\s*\|/.test(line)
    if (row !== (mode === 'table')) { flush(); mode = row ? 'table' : 'prose' }
    buf.push(line)
  }
  flush()
  return out
}

/** The side padding a teammate's bubbles sit in (avatar gutter in groups, room on the right in DMs). */
function Inset({ children }: { children: React.ReactNode }) {
  const { group } = useActions()
  return <View style={{ alignSelf: 'stretch', alignItems: 'flex-start', paddingLeft: group ? GUTTER : 0, paddingRight: group ? 8 : 48 }}>{children}</View>
}

/**
 * A teammate's reply. Tables and code blocks break out of the bubble to the chat's full width, and the prose around
 * them stays in bubbles. Wide rows render inside a `bleed` TeammateBlock.
 */
function Reply({ text, first, last, highlighted, head, tail }: {
  text: string; first: boolean; last: boolean; highlighted?: boolean; head?: React.ReactNode; tail?: React.ReactNode
}) {
  const { handles, onSend } = useActions()
  const parts = splitWide(stripCues(text))
  if (!parts.some((p) => p.wide)) {
    return (
      <Bubble side="left" first={first} last={last} highlighted={highlighted}>
        {head}
        {/* The parts, not the raw text: a drawing that can't be drawn was left out of them. */}
        <Markdown value={parts.map((p) => p.text).join('\n\n')} mentions={handles} />
        {tail}
      </Bubble>
    )
  }
  if (head && parts[0].wide) parts.unshift({ wide: false, text: '' })
  return [...parts.map((p, i) => p.wide ? (
    <View key={i} style={{ alignSelf: 'stretch', marginVertical: 2 }}>{wide(p.text, onSend)}</View>
  ) : (
    // Prose around a full-width block spans the same width, so their edges line up.
    <View key={i} style={{ alignSelf: 'stretch', marginVertical: 2 }}>
      <Bubble side="left" first={first && i === 0} last={last && i === parts.length - 1} highlighted={highlighted} style={{ alignSelf: 'stretch' }}>
        {i === 0 && head}
        {!!p.text && <Markdown value={p.text} mentions={handles} />}
      </Bubble>
    </View>
  )), tail && <Inset key="tail">{tail}</Inset>]
}

/** A wide block: a teammate's drawing (```openui) or code/table markdown. */
function wide(text: string, onSend: (text: string) => void) {
  const d = drawing(text)
  return d ? <GenUI source={d.source} streaming={d.open} onChoose={onSend} /> : <Markdown value={text} />
}

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
  const bg = tone === 'panel' ? c.panel : c.mine
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

function TeammateBlock({ teammate, first, paused, working, bleed, children }: {
  teammate?: Teammate; first: boolean; paused: boolean; working?: boolean; bleed?: boolean; children: React.ReactNode
}) {
  const live = !!working
  const { group } = useActions()
  return (
    <View style={{ marginTop: first ? 14 : 2 }}>
      {first && group && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          {teammate ? <TeammateAvatar teammate={teammate} size={AVATAR} state={live ? 'working' : 'default'} paused={paused && !live} /> : <View style={{ width: AVATAR }} />}
          <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
            {teammate?.name ?? 'Former teammate'}
            {teammate && <Text variant="footnote" color="ink3">{`  ${teammate.role}`}</Text>}
          </Text>
        </View>
      )}
      {bleed
        ? <View style={{ alignItems: 'flex-start' }}>{children}</View>
        : <View style={{ paddingLeft: group ? GUTTER : 0, paddingRight: group ? 8 : 48, alignItems: 'flex-start' }}>{children}</View>}
    </View>
  )
}

const EMOJI = ['👍', '❤️', '😂', '🔥', '🙏'] as const  // the sixth slot opens every emoji

function messageMenu(m: ChatMessage, onReply?: (m: ChatMessage) => void, onReact?: (m: ChatMessage, emoji: string) => void) {
  if (onReact) warmEmojis()
  showMenu({
    title: fullTime(m.created_at),
    reactions: onReact && !m.local
      ? { emojis: EMOJI, selected: m.meta.reactions?.find((r) => r.by === 'user')?.emoji, onPick: (e) => onReact(m, e),
          onMore: () => showEmojiPicker((e) => onReact(m, e), 320) }  // after the menu's close animation
      : undefined,
    items: [
      ...(onReply ? [{ label: 'Reply', icon: ArrowTurnBackwardIcon, onPress: () => onReply(m) }] : []),
      { label: 'Copy text', icon: Copy01Icon, onPress: async () => { await Clipboard.setStringAsync(m.text); copied() } },
    ],
  })
}

/**
 * Reactions under a bubble, WhatsApp-style: a small pill overlapping its bottom edge with each emoji used and how
 * many. Tap it to see who reacted (and take yours back).
 */
function Reactions({ m, side }: { m: ChatMessage; side: 'left' | 'right' }) {
  const { c, scheme } = useTheme()
  const { onReact } = useActions()
  const [open, setOpen] = useState(false)
  const list = m.meta.reactions ?? []
  if (!list.length) return null
  const kinds = [...new Set(list.map((r) => r.emoji))]
  return (
    <>
      <Animated.View entering={FadeIn.duration(motion.duration.fast)} style={[{ marginTop: -8, zIndex: 1, alignSelf: side === 'left' ? 'flex-start' : 'flex-end', marginHorizontal: 10 }, elevation(scheme, 1)]}>
        <Press
          radius={12}
          onPress={() => { haptic.tap(); setOpen(true) }}
          accessibilityLabel={`Reactions: ${list.map((r) => r.emoji).join(' ')}`}
          accessibilityHint="Shows who reacted"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 24, paddingHorizontal: 7, borderRadius: 12, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}
        >
          {kinds.slice(0, 3).map((e) => <Text key={e} style={{ fontSize: 13, lineHeight: 17 }}>{e}</Text>)}
          {list.length > 1 && <Text variant="footnote" color="ink3" tabular style={{ marginLeft: 1 }}>{list.length}</Text>}
        </Press>
      </Animated.View>
      <Sheet open={open} onClose={() => setOpen(false)} title="Reactions">
        <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          {list.map((r) => <ReactorRow key={r.by} by={r.by} emoji={r.emoji} onRemove={r.by === 'user' ? () => { setOpen(false); onReact(m, r.emoji) } : undefined} />)}
        </View>
      </Sheet>
    </>
  )
}

function ReactorRow({ by, emoji, onRemove }: { by: string; emoji: string; onRemove?: () => void }) {
  const { c } = useTheme()
  const t = useTeammate(by === 'user' ? null : by)
  return (
    <ListRow
      title={by === 'user' ? 'You' : t?.name ?? 'Former teammate'}
      subtitle={onRemove ? 'Tap to remove' : t?.role}
      leading={t ? <TeammateAvatar teammate={t} size={32} interactive={false} /> : (
        <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={UserIcon} size={16} color="ink2" />
        </View>
      )}
      accessory={<Text style={{ fontSize: 22, lineHeight: 28 }}>{emoji}</Text>}
      onPress={onRemove}
      style={{ minHeight: 52 }}
    />
  )
}

function TeammateMessage({ m, teammate, first, last, paused, working, replyTo, highlighted }: {
  m: ChatMessage; teammate?: Teammate; first: boolean; last: boolean; paused: boolean; working?: boolean; replyTo?: ChatMessage | null; highlighted?: boolean
}) {
  const { onReply, onReact } = useActions()
  const calls = m.meta.tool_calls ?? []
  const wide = hasWideBlock(m.text)
  const Pad = wide ? Inset : Fragment
  // Pictures a teammate sends (generated images) stand on their own under the reply, not inside its bubble.
  const pictures = m.meta.attachments?.filter((a) => a.mime.startsWith('image/')) ?? []
  const files = m.meta.attachments?.filter((a) => !a.mime.startsWith('image/')) ?? []
  return (
    <SwipeToReply onReply={() => onReply(m)}>
      <TeammateBlock teammate={teammate} first={first} paused={paused} working={working} bleed={wide}>
        {/* A follow-up's capsule above already says why they're speaking up. */}
        {m.proactive && m.meta.event_type !== 'follow_up' && <Pad><EventLabel type={m.meta.event_type} runId={m.run_id} /></Pad>}
        {(!!m.text || !(pictures.length + files.length)) && (
          <Pressable onLongPress={() => { haptic.light(); messageMenu(m, onReply, onReact) }} delayLongPress={350} accessibilityHint="Long press to react, reply or copy" style={wide ? { alignSelf: 'stretch' } : { maxWidth: '100%' }}>
            <Reply text={m.text} first={first} last={last} highlighted={highlighted} head={m.reply_to ? <ReplyQuote id={m.reply_to} target={replyTo} /> : undefined} />
          </Pressable>
        )}
        {pictures.map((a) => <Pad key={a.path}><Picture a={a} /></Pad>)}
        {/* Documents too: a card of their own under the reply, opening in the viewer. */}
        {files.map((a) => <Pad key={a.path}><DocCard a={a} /></Pad>)}
        {Array.isArray(m.meta.phone_actions) && (
          <Pad>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {(m.meta.phone_actions as PhoneAction[]).map((a, i) => (
                <Chip key={i} label={phoneLabel(a)} size="sm" accessibilityLabel={`${phoneLabel(a)}: do it again`} onPress={() => { haptic.tap(); runPhoneAction(a) }} />
              ))}
            </View>
          </Pad>
        )}
        <Pad><Reactions m={m} side="left" /></Pad>
        {calls.length > 0 && <Pad><ToolCalls calls={calls} /></Pad>}
      </TeammateBlock>
    </SwipeToReply>
  )
}

function UserMessage({ m, first, last, replyTo, highlighted }: {
  m: ChatMessage; first: boolean; last: boolean; replyTo?: ChatMessage | null; highlighted?: boolean
}) {
  const { onReply, onRetryMessage, onDiscardMessage, onReact, handles } = useActions()
  return (
    <SwipeToReply onReply={() => onReply(m)} enabled={!m.local}>
      <View style={{ alignItems: 'flex-end', marginTop: first ? 14 : 2 }}>
        <Pressable
          onLongPress={() => { haptic.light(); messageMenu(m, m.local ? undefined : onReply, onReact) }}
          delayLongPress={350}
          style={{ maxWidth: '82%' }}
          accessibilityLabel={`You: ${m.text}${m.local === 'failed' ? '. Not sent' : m.local === 'queued' ? '. Waiting for connection' : ''}`}
        >
          <Bubble side="right" first={first} last={last} tone="mine" highlighted={highlighted} style={{ opacity: m.local === 'sending' ? 0.6 : 1 }}>
            {m.reply_to && <ReplyQuote id={m.reply_to} target={replyTo} />}
            <Attachments items={m.meta.attachments} />
            {!!m.text && <UserText text={m.text} known={m.meta.apps?.length ? new Set([...handles, ...m.meta.apps.map(appToken)]) : handles} />}
          </Bubble>
        </Pressable>
        <Reactions m={m} side="right" />
        {m.local === 'queued' && (
          <Animated.View entering={FadeIn.duration(motion.duration.quick)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <Icon icon={Clock01Icon} size={13} color="ink3" />
            <Text variant="footnote" color="ink3">Sends when you’re back online</Text>
            <Press radius={8} static onPress={() => onDiscardMessage(m)} style={{ paddingHorizontal: 8, minHeight: 32, justifyContent: 'center' }}>
              <Text variant="label" color="ink3">Delete</Text>
            </Press>
          </Animated.View>
        )}
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
  const preview = target ? plainText(target.text) || (target.meta.attachments?.length ? 'Attachment' : '') : 'Earlier message'
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
  const [open, setOpen] = useState(false)
  const ratio = a.width && a.height ? a.width / a.height : 4 / 3
  const w = single ? 240 : 118
  return (
    <Pressable onPress={() => url && setOpen(true)} accessibilityRole="imagebutton" accessibilityLabel={a.name} accessibilityHint="Opens it full screen">
      <Squircle style={{ width: w, height: single ? Math.min(w / ratio, 320) : w, borderRadius: 14, overflow: 'hidden', backgroundColor: c.panel3 }}>
        {url && <Image source={url} style={{ flex: 1 }} contentFit="cover" transition={motion.duration.fast} />}
      </Squircle>
      <ImageViewer url={open ? url ?? null : null} name={a.name} onClose={() => setOpen(false)} />
    </Pressable>
  )
}

/** A teammate's picture: large, on its own, with a save button on it; tap for full screen. */
function Picture({ a }: { a: Attachment }) {
  const { c } = useTheme()
  const url = useSignedUrl(a.path)
  const [open, setOpen] = useState(false)
  const w = Math.min(useWindowDimensions().width * 0.78, 340)
  // Generated images say their size; screenshots and others learn it when they load (a 16:9 screen isn't a square).
  const [loaded, setLoaded] = useState<number | null>(null)
  const ratio = a.width && a.height ? a.width / a.height : loaded ?? 1
  return (
    <Pressable onPress={() => url && setOpen(true)} onLongPress={() => url && saveImage(url, a.name)} delayLongPress={350}
      accessibilityRole="imagebutton" accessibilityLabel={a.name} accessibilityHint="Opens it full screen; long press saves it"
      style={{ marginTop: 6 }}>
      <Squircle style={{ width: w, height: w / ratio, borderRadius: 20, overflow: 'hidden', backgroundColor: c.panel2 }}>
        {url ? <Image source={url} style={{ flex: 1 }} contentFit="cover" transition={motion.duration.fast}
          onLoad={(e) => { if (!a.width && e.source.width && e.source.height) setLoaded(e.source.width / e.source.height) }} />
          : <Skeleton width={w} height={w / ratio} radius={0} />}
      </Squircle>
      {url && (
        <View style={{ position: 'absolute', right: 8, bottom: 8 }}>
          <IconButton icon={Download03Icon} variant="soft" round size={36} iconSize={18} accessibilityLabel="Save to photos" onPress={() => saveImage(url, a.name)} />
        </View>
      )}
      <ImageViewer url={open ? url ?? null : null} name={a.name} onClose={() => setOpen(false)} />
    </Pressable>
  )
}

/** Tap a file to download it under its own name (Android saves it and offers to open it). */
async function openFile(a: Attachment) {
  haptic.tap()
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(a.path, 60 * 60, { download: a.name })
  if (error || !data?.signedUrl) { toast({ title: `Unable to open ${a.name}`, body: error?.message, tone: 'error' }); return }
  Linking.openURL(data.signedUrl)
}

/** Opens a chat file in the app's viewer (download, Vault and share are there). */
function openViewer(a: Attachment) {
  haptic.tap()
  router.push({ pathname: '/file', params: { path: a.path, name: a.name, mime: a.mime, size: String(a.size) } })
}

const firstPages = new Map<string, string>()

/** A document a teammate sends: its first page (PDFs) or its icon, its name and size, open on tap, download beside. */
function DocCard({ a }: { a: Attachment }) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const pdf = a.mime === 'application/pdf' || a.name.toLowerCase().endsWith('.pdf')
  const [page, setPage] = useState(firstPages.get(a.path))
  const signedUrl = useSignedUrl(a.path)
  const w = Math.min(320, width * 0.78)
  useEffect(() => {
    if (!pdf || page || !signedUrl || !Phone?.pdfPage) return
    let on = true
    localCopy({ id: a.path, name: a.name, size: a.size, src: signedUrl })
      .then((f) => Phone!.pdfPage(f.uri, 0, Math.round(w * 2)))
      .then((p) => { firstPages.set(a.path, p.uri); if (on) setPage(p.uri) }, () => {})
    return () => { on = false }
  }, [pdf, page, signedUrl, a.path, a.name, a.size, w])
  const ext = a.name.split('.').pop()?.toUpperCase().slice(0, 4) ?? ''
  return (
    <Press radius={20} onPress={() => openViewer(a)} accessibilityLabel={`${a.name}, ${formatSize(a.size)}. Opens it`}
      onLongPress={() => { haptic.light(); showMenu({ title: a.name, items: [
        { label: 'Download', icon: Download03Icon, onPress: () => openFile(a) },
        { label: 'Save to Vault', icon: VaultIcon, onPress: () => saveAttachment({ path: a.path, name: a.name }).then(
          () => toast({ title: 'Saved to your vault', body: a.name, tone: 'success' }),
          (e) => toast({ title: 'Unable to save it', body: (e as Error).message, tone: 'error' })) },
      ] }) }}
      outerStyle={{ width: w, marginTop: 6 }} style={{ borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, overflow: 'hidden' }}>
      <View style={{ height: 150, backgroundColor: c.panel2, alignItems: 'center', justifyContent: page ? 'flex-start' : 'center', overflow: 'hidden' }}>
        {page
          ? <Image source={page} style={{ width: w - 32, height: (w - 32) * 1.41, marginTop: 16, borderRadius: 6 }} contentFit="cover" transition={150} />
          : <FileIcon name={a.name} mime={a.mime} size={72} />}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line }}>
        <FileIcon name={a.name} mime={a.mime} size={30} glow={false} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="label" numberOfLines={1}>{a.name}</Text>
          <Text variant="footnote" color="ink3">{[ext, formatSize(a.size)].filter(Boolean).join(' · ')}</Text>
        </View>
        <IconButton icon={Download03Icon} size={40} iconSize={19} color={c.ink2} accessibilityLabel={`Download ${a.name}`} onPress={() => openFile(a)} />
      </View>
    </Press>
  )
}

function FileChip({ a }: { a: Attachment }) {
  const { c } = useTheme()
  const ext = a.name.split('.').pop()?.toUpperCase().slice(0, 4) ?? ''
  const menu = () => {
    haptic.light()
    showMenu({
      title: a.name,
      items: [
        { label: 'Download', icon: Download03Icon, onPress: () => openFile(a) },
        { label: 'Save to Vault', icon: VaultIcon, onPress: () => saveAttachment({ path: a.path, name: a.name }).then(
          () => toast({ title: 'Saved to your vault', body: a.name, tone: 'success' }),
          (e) => toast({ title: 'Unable to save it', body: (e as Error).message, tone: 'error' })) },
      ],
    })
  }
  return (
    <Pressable onPress={() => openViewer(a)} onLongPress={menu} accessibilityRole="button" accessibilityLabel={`${a.name}, ${formatSize(a.size)}`}
      accessibilityHint="Opens it. Long-press to download or save it to your vault.">
    <Squircle style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, backgroundColor: c.wash, padding: 8, paddingRight: 12, minWidth: 180 }}>
      <FileTile item={a} size={36} />
      <View style={{ flexShrink: 1 }}>
        <Text variant="label" numberOfLines={1}>{a.name}</Text>
        <Text variant="footnote" color="ink3">{[ext, formatSize(a.size)].filter(Boolean).join(' · ')}</Text>
      </View>
      <View style={{ flex: 1 }} />
      <Icon icon={Download03Icon} size={18} color="ink3" />
    </Squircle>
    </Pressable>
  )
}

function EventLabel({ type, runId }: { type?: string; runId?: string | null }) {
  // An automation's reply says which automation ("Automation · Mail brief") and opens it; other events say what came in.
  const auto = type?.startsWith('automation:') ? type.slice('automation:'.length) : null
  const label = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <Icon icon={auto ? WorkflowIcon : FlashIcon} size={13} color="ink3" />
      <Text variant="footnote" color="ink3" numberOfLines={1}>{auto ? `Automation · ${auto}` : `Started by an event${type ? `: ${type}` : ''}`}</Text>
    </View>
  )
  if (!auto || !runId) return <View style={{ marginBottom: 4 }}>{label}</View>
  return (
    <Press radius={8} static onPress={() => openAutomationOfRun(runId)} accessibilityHint="Opens the automation"
      outerStyle={{ alignSelf: 'flex-start', marginBottom: 4 }} style={{ paddingVertical: 2, paddingRight: 4 }}>
      {label}
    </Press>
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

// Android can't lay out one selectable Text of thousands of characters: it measures empty and the bubble shrinks to
// its padding. So a long message is one Text per paragraph, and a paragraph that's still huge isn't selectable (the
// hold menu's Copy text has it all).
const SELECTABLE_MAX = 1200

function UserText({ text, known }: { text: string; known: Set<string> }) {
  if (text.length <= SELECTABLE_MAX) return <Text selectable>{renderMentions(text, known)}</Text>
  return (
    <View style={{ gap: 8 }}>
      {text.split(/\n{2,}/).map((p, i) => <Text key={i} selectable={p.length <= SELECTABLE_MAX}>{renderMentions(p.trim(), known)}</Text>)}
    </View>
  )
}

function renderMentions(text: string, known: Set<string>) {
  return mentionParts(text, known).map((part, i) =>
    part.mention ? <Text key={i} variant="bodyMedium" color="tube">{part.text}</Text> : part.text)
}

/** Older runs handed work over with a separate note; show it the way teammates talk now: an @mention in a message. */
function HandoffMessage({ m, first, last, paused }: { m: ChatMessage; first: boolean; last: boolean; paused: boolean }) {
  const from = useTeammate(m.teammate_id)
  const to = useTeammate(m.meta.to_teammate_id)
  const text = `@${to?.handle ?? 'teammate'} ${m.meta.note ?? ''}`.trim()
  return <TeammateMessage m={{ ...m, text }} teammate={from} first={first} last={last} paused={paused} />
}

/**
 * A centred capsule for things that happen in the chat (like WhatsApp's "X changed the group name"): what happened in
 * medium weight, then the detail after the colon ("Calendy set a follow-up for 6 PM: review the copy").
 */
/** A follow-up capsule's colour by stage: set (accent), firing now (amber), done (green), cancelled or dropped (red). */
const FOLLOWUP_TONE: Record<string, Tone> = {
  created: 'tube', set: 'tube', noted: 'tube', fired: 'warning', time: 'warning', met: 'warning', deadline: 'warning',
  done: 'success', cancelled: 'danger', dropped: 'danger',
}
/** Automation capsules: set up / changed / back on (accent), paused (amber), deleted (red). */
const AUTOMATION_TONE: Record<string, Tone> = { created: 'tube', updated: 'tube', resumed: 'tube', paused: 'warning', deleted: 'danger' }

function ErrorRow({ m, onRetry }: { m: ChatMessage; onRetry: () => void }) {
  const { group } = useActions()
  return (
    <View style={{ marginTop: 10, marginLeft: group ? GUTTER : 0 }}>
      <Notice tone="error" title="Couldn’t finish that" body={m.text || 'The run stopped with an error.'} action={{ label: 'Retry', onPress: onRetry }} collapsible />
    </View>
  )
}
