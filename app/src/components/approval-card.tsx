import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated'
import { Image } from 'expo-image'
import { Edit02Icon } from '@hugeicons/core-free-icons'

import { Capsule } from '@/components/chat/capsule'
import { ApiError, BASE, api } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import type { Approval, Teammate } from '@/lib/types'
import { motion, radius, type as typeScale, useTheme } from '@/theme'
import {
  Beam, Button, Sheet, Squircle, TeammateAvatar, Text, TextField, haptic, toast,
} from '@/ui'

type Shape = 'email' | 'post' | 'code' | 'other'

const LABELS: Record<string, string> = {
  recipient_email: 'To', to: 'To', recipient: 'To', cc: 'Cc', bcc: 'Bcc', subject: 'Subject', body: 'Body',
  text: 'Text', content: 'Text', title: 'Title', head: 'From branch', base: 'Into branch', branch: 'Branch',
  owner: 'Owner', repo: 'Repository', diff: 'Changes', message: 'Message', commit_message: 'Commit message',
}
const label = (k: string) => ({ what: 'Does', site: 'Site', cmd: 'Command', cwd: 'In folder', folder: 'Drive folder', pattern: 'Files', app: 'App', task: 'To do' } as Record<string, string>)[k] ?? LABELS[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase())

function shapeOf(a: Approval): Shape {
  const d = a.draft
  const tool = a.tool_name.toUpperCase()
  if ((d.recipient_email || d.to) && (d.subject !== undefined || d.body !== undefined)) return 'email'
  if (tool.includes('GITHUB') || tool.startsWith('GIT_') || 'diff' in d || ('head' in d && 'base' in d)) return 'code'
  if (/POST|TWEET|THREAD|LINKEDIN|SOCIAL/.test(tool) && (typeof d.text === 'string' || typeof d.content === 'string')) return 'post'
  return 'other'
}

const ORDER: Record<Shape, string[]> = {
  email: ['recipient_email', 'to', 'cc', 'bcc', 'subject', 'body'],
  post: ['text', 'content'],
  code: ['owner', 'repo', 'title', 'head', 'base', 'branch', 'body', 'commit_message', 'diff'],
  other: [],
}

const approveLabel: Record<Shape, string> = { email: 'Approve and send', post: 'Approve and post', code: 'Approve', other: 'Approve' }

function fields(a: Approval, shape: Shape) {
  // A button on a web page: what it does and the text it sends (the screenshot shows the rest).
  if (a.tool_name === 'browser_commit') return ['what', 'text', 'site'].filter((k) => a.draft[k])
  // A computer action: just what it does (the title says why; sudo and timeouts are plumbing).
  if (a.tool_name.startsWith('computer_')) {
    return ['app', 'task', 'cmd', 'path', 'folder', 'pattern', 'content', ...(a.draft.cwd && a.draft.cwd !== '~' ? ['cwd'] : [])].filter((k) => k in a.draft && a.draft[k] !== '')
  }
  const keys = Object.keys(a.draft)
  const first = ORDER[shape].filter((k) => keys.includes(k))
  return [...first, ...keys.filter((k) => !first.includes(k))]
}

const show = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : JSON.stringify(v, null, 2))

export interface ApprovalCardProps {
  approval: Approval
  teammate?: Teammate
  /** Beam around the pending card (one place only: the live thread). */
  beam?: boolean
  /** Shows "in <thread>" context on the Approvals tab. */
  context?: string
  onDecided?: () => void
}

/**
 * An approval inline in chat and on the Approvals tab. Pending: the draft by shape with
 * Approve / Edit / Reject. Decided: collapses to one line with the success check.
 */
export function ApprovalCard({ approval, teammate, beam, context, onDecided }: ApprovalCardProps) {
  const { c } = useTheme()
  const shape = shapeOf(approval)
  const [status, setStatus] = useState(approval.status)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, unknown>>(approval.draft)
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [justDecided, setJustDecided] = useState(false)
  // An admin command on a linked computer: their password, sent once with the approval (never stored by the service).
  const admin = approval.tool_name === 'computer_run' && approval.draft.sudo === true
  const [password, setPassword] = useState('')

  const current = approval.status !== 'pending' ? approval.status : status
  const edited = JSON.stringify(draft) !== JSON.stringify(approval.draft)

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(action)
    try {
      await api(`/approvals/${approval.id}`, {
        method: 'POST',
        json: {
          action, ...(action === 'approve' && edited ? { args: draft } : {}), ...(action === 'reject' && note.trim() ? { note: note.trim() } : {}),
          ...(action === 'approve' && admin ? { secret: password } : {}),
        },
      })
      if (action === 'approve') haptic.success(); else haptic.warning()
      setJustDecided(true)
      setStatus(action === 'approve' ? 'approved' : 'rejected')
      setRejecting(false)
      onDecided?.()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast({ title: 'Already handled', body: 'This request was decided or expired in the meantime.' })
        onDecided?.()
      } else {
        toast({ title: action === 'approve' ? 'Unable to approve' : 'Unable to reject', body: e instanceof Error ? e.message : undefined, tone: 'error' })
      }
    } finally {
      setBusy(null)
    }
  }

  if (current !== 'pending') {
    // Decided: the same capsule as follow-ups in the chat; tapping it shows what exactly was approved.
    const text = current === 'approved' ? 'Approved' : current === 'rejected' ? 'Rejected' : 'Expired'
    const shown = fields(approval, shape)
    return (
      <Animated.View entering={justDecided ? FadeIn.duration(motion.duration.fast) : undefined} layout={LinearTransition.duration(motion.duration.fast)}>
        <Capsule
          text={`${text}: ${approval.title}`}
          tone={current === 'approved' ? 'success' : current === 'rejected' ? 'danger' : 'neutral'}
          detail={(
            <View style={{ gap: 16 }}>
              {shown.map((k) => (
                <View key={k} style={{ gap: 6 }}>
                  <Text variant="label" color="ink3">{label(k)}</Text>
                  {k === 'cmd' || k === 'diff' ? (
                    <Squircle style={{ borderRadius: radius.md, backgroundColor: c.panel2, padding: 12 }}>
                      <Text style={[typeScale.mono, { color: c.ink }]} selectable>{show(approval.final_args?.[k] ?? approval.draft[k])}</Text>
                    </Squircle>
                  ) : (
                    <Text variant="body" color="ink2" selectable>{show(approval.final_args?.[k] ?? approval.draft[k])}</Text>
                  )}
                </View>
              ))}
              {!!approval.note && (
                <View style={{ gap: 6 }}>
                  <Text variant="label" color="ink3">Your note</Text>
                  <Text variant="body" color="ink2">{approval.note}</Text>
                </View>
              )}
              <View style={{ height: 1, backgroundColor: c.line }} />
              <Text variant="footnote" color="ink4">
                {[teammate && `Asked by ${teammate.name}`, approval.decided_at && `${text} ${relativeTime(approval.decided_at)}`].filter(Boolean).join(' · ')}
              </Text>
            </View>
          )}
        />
      </Animated.View>
    )
  }

  const keys = fields(approval, shape)
  // A web page button: exactly what they see gets pressed, so there's nothing to edit.
  const commit = approval.tool_name === 'browser_commit'
  const body = (
    <Squircle style={{ borderRadius: radius.lg, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {teammate && <TeammateAvatar teammate={teammate} size={22} interactive={false} />}
        <Text variant="footnote" color="ink3" style={{ flex: 1 }} numberOfLines={1}>
          {teammate ? `${teammate.name} needs your approval` : 'Needs your approval'}{context ? ` · ${context}` : ''}
        </Text>
      </View>
      <Text variant="headline" accessibilityRole="header">{approval.title}</Text>
      {commit && typeof approval.draft.image === 'string' && (
        <Squircle style={{ borderRadius: radius.md, backgroundColor: c.panel2, overflow: 'hidden', alignItems: 'center' }}>
          <Image source={{ uri: BASE + approval.draft.image }} style={{ width: '100%', height: 380 }} contentFit="contain"
            accessibilityLabel="The page as it is now" />
        </Squircle>
      )}

      <View style={{ gap: 10 }}>
        {keys.map((k) => {
          const v = draft[k]
          const editable = editing && typeof v === 'string'
          const long = typeof v === 'string' && (v.length > 60 || v.includes('\n') || ['body', 'text', 'content', 'diff'].includes(k))
          if (editable) {
            return (
              <TextField
                key={k}
                label={label(k)}
                value={v}
                multiline={long}
                showCount={shape === 'post'}
                maxLength={shape === 'post' ? 280 : undefined}
                onChangeText={(t) => setDraft((d) => ({ ...d, [k]: t }))}
                autoCapitalize={k.includes('email') || k === 'to' ? 'none' : 'sentences'}
              />
            )
          }
          const isCode = k === 'diff' || k === 'cmd' || (typeof v !== 'string' && typeof v === 'object')
          return (
            <View key={k} style={{ gap: 3 }}>
              <Text variant="footnote" color="ink3">{label(k)}</Text>
              {isCode ? (
                <Squircle style={{ borderRadius: radius.sm + 2, backgroundColor: c.panel2, overflow: 'hidden' }}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 10 }}>
                    <Text style={[typeScale.mono, { color: c.ink }]} selectable>{show(v)}</Text>
                  </ScrollView>
                </Squircle>
              ) : (
                <Text variant={long ? 'body' : 'bodyMedium'} selectable numberOfLines={long ? 12 : 3}>{show(v)}</Text>
              )}
              {shape === 'post' && typeof v === 'string' && (
                <Text variant="footnote" tabular color={v.length > 280 ? 'danger' : 'ink3'} align="right">{v.length}/280</Text>
              )}
            </View>
          )
        })}
      </View>

      {admin && (
        <TextField label="Your computer’s password" hint="For this command only. Tubelight passes it to sudo once and doesn’t keep it."
          secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" value={password} onChangeText={setPassword} />
      )}
      {/* Primary action on its own row so three labels never wrap unevenly on a 360pt phone. */}
      <View style={{ gap: 8, marginTop: 2 }}>
        <Button
          label={admin ? 'Approve as admin' : commit ? `Approve: ${String(approval.draft.button ?? 'press it')}` : edited ? `${approveLabel[shape]} edited` : approveLabel[shape]}
          fullWidth
          loading={busy === 'approve'}
          disabled={!!busy || (admin && !password)}
          onPress={() => decide('approve')}
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {!commit && <Button
            label={editing ? 'Done editing' : 'Edit'}
            variant="soft"
            icon={editing ? undefined : Edit02Icon}
            fullWidth
            style={{ flex: 1 }}
            disabled={!!busy || !keys.some((k) => typeof approval.draft[k] === 'string')}
            onPress={() => { haptic.tap(); setEditing((e) => !e) }}
          />}
          <Button label="Reject" variant="outline" fullWidth style={{ flex: 1 }} disabled={!!busy} onPress={() => setRejecting(true)} />
        </View>
      </View>

      <Sheet open={rejecting} onClose={() => setRejecting(false)} title="Reject this request?">
        <View style={{ paddingHorizontal: 20, gap: 14 }}>
          <Text variant="caption" color="ink3">
            {teammate ? `${teammate.name} won’t` : 'Your teammate won’t'} {approval.title.charAt(0).toLowerCase() + approval.title.slice(1)}. A note helps them try again.
          </Text>
          <TextField label="Note (optional)" placeholder="Keep it shorter and skip the emoji" multiline value={note} onChangeText={setNote} />
          <Button label="Reject request" variant="destructive" fullWidth loading={busy === 'reject'} onPress={() => decide('reject')} />
        </View>
      </Sheet>
    </Squircle>
  )

  return (
    <Animated.View layout={LinearTransition.duration(motion.duration.fast)}>
      {beam ? <Beam radius={radius.lg}>{body}</Beam> : body}
    </Animated.View>
  )
}
