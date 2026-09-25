import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated'
import { Cancel01Icon, Clock01Icon, Edit02Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { ApiError, api } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import type { Approval, Teammate } from '@/lib/types'
import { motion, radius, type as typeScale, useTheme } from '@/theme'
import {
  Beam, Button, Icon, Sheet, Squircle, SuccessCheck, TeammateAvatar, Text, TextField, haptic, toast,
} from '@/ui'

type Shape = 'email' | 'post' | 'code' | 'other'

const LABELS: Record<string, string> = {
  recipient_email: 'To', to: 'To', recipient: 'To', cc: 'Cc', bcc: 'Bcc', subject: 'Subject', body: 'Body',
  text: 'Text', content: 'Text', title: 'Title', head: 'From branch', base: 'Into branch', branch: 'Branch',
  owner: 'Owner', repo: 'Repository', diff: 'Changes', message: 'Message', commit_message: 'Commit message',
}
const label = (k: string) => LABELS[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase())

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

  const current = approval.status !== 'pending' ? approval.status : status
  const edited = JSON.stringify(draft) !== JSON.stringify(approval.draft)

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(action)
    try {
      await api(`/approvals/${approval.id}`, {
        method: 'POST',
        json: { action, ...(action === 'approve' && edited ? { args: draft } : {}), ...(action === 'reject' && note.trim() ? { note: note.trim() } : {}) },
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
    const text = current === 'approved' ? 'Approved' : current === 'rejected' ? 'Rejected' : 'Expired'
    return (
      <Animated.View entering={justDecided ? FadeIn.duration(motion.duration.fast) : undefined} layout={LinearTransition.duration(motion.duration.fast)}>
        <Squircle style={{ borderRadius: radius.md, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {current === 'approved'
            ? (justDecided ? <SuccessCheck size={20} /> : <Icon icon={Tick02Icon} size={18} color="success" strokeWidth={2} />)
            : <Icon icon={current === 'rejected' ? Cancel01Icon : Clock01Icon} size={18} color="ink3" />}
          <Text variant="caption" color="ink2" numberOfLines={2} style={{ flex: 1 }}>
            <Text variant="label" color={current === 'approved' ? 'success' : 'ink2'}>{text}</Text>
            {`  ${approval.title}`}
          </Text>
          {approval.decided_at && <Text variant="footnote" color="ink3" tabular>{relativeTime(approval.decided_at)}</Text>}
        </Squircle>
      </Animated.View>
    )
  }

  const keys = fields(approval, shape)
  const body = (
    <Squircle style={{ borderRadius: radius.lg, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {teammate && <TeammateAvatar teammate={teammate} size={22} interactive={false} />}
        <Text variant="footnote" color="ink3" style={{ flex: 1 }} numberOfLines={1}>
          {teammate ? `${teammate.name} needs your approval` : 'Needs your approval'}{context ? ` · ${context}` : ''}
        </Text>
      </View>
      <Text variant="headline" accessibilityRole="header">{approval.title}</Text>

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
          const isCode = k === 'diff' || (typeof v !== 'string' && typeof v === 'object')
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

      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
        <Button
          label={edited ? `${approveLabel[shape]} edited` : approveLabel[shape]}
          size="sm"
          loading={busy === 'approve'}
          disabled={!!busy}
          onPress={() => decide('approve')}
        />
        <Button
          label={editing ? 'Done editing' : 'Edit'}
          size="sm"
          variant="soft"
          icon={editing ? undefined : Edit02Icon}
          disabled={!!busy || !keys.some((k) => typeof approval.draft[k] === 'string')}
          onPress={() => { haptic.tap(); setEditing((e) => !e) }}
        />
        <Button label="Reject" size="sm" variant="ghost" disabled={!!busy} onPress={() => setRejecting(true)} />
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
