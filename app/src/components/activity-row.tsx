import { router } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { ArrowDown01Icon, ArrowUpRight01Icon } from '@hugeicons/core-free-icons'

import { CodeBlock } from '@/components/form-bits'
import { describe, durationLabel } from '@/lib/activity'
import { ago, fullTime } from '@/lib/format'
import type { Activity } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { radius, useTheme } from '@/theme'
import { Button, Chip, Collapse, Icon, Press, TeammateAvatar, Text, toast, useFlip } from '@/ui'

const MAX = 1600

const clipText = (s: string) => (s.length > MAX ? s.slice(0, MAX) + '\n…' : s)

/** JSON-looking strings become pretty JSON; everything else stays as written. */
function pretty(v: unknown): { text: string; mono: boolean } {
  if (typeof v === 'string') {
    const t = v.trim()
    if ((t.startsWith('{') || t.startsWith('[')) && t.length > 2) {
      try { return { text: clipText(JSON.stringify(JSON.parse(t), null, 2)), mono: true } } catch { return { text: clipText(t), mono: true } }
    }
    return { text: clipText(v), mono: false }
  }
  if (v == null) return { text: '—', mono: false }
  if (typeof v !== 'object') return { text: String(v), mono: false }
  return { text: clipText(JSON.stringify(v, null, 2)), mono: true }
}

const label = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ')

function KeyValues({ value }: { value: unknown }) {
  const { c } = useTheme()
  if (value == null) return null
  const entries = typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as object) : [['value', value] as const]
  if (entries.length === 0) return null
  return (
    <View style={{ gap: 10 }}>
      {entries.map(([k, v]) => {
        const p = pretty(v)
        return (
          <View key={k} style={{ gap: 3 }}>
            <Text variant="footnote" color="ink3">{label(k)}</Text>
            {p.mono ? (
              <View style={{ borderRadius: radius.sm + 2, backgroundColor: c.panel2, padding: 10 }}>
                <Text variant="mono" selectable style={{ fontSize: 12, lineHeight: 17, color: c.ink2 }}>{p.text}</Text>
              </View>
            ) : (
              <Text variant="caption" color="ink" selectable>{p.text}</Text>
            )}
          </View>
        )
      })}
    </View>
  )
}

/** Unified diff with added/removed lines tinted. */
export function DiffBlock({ diff }: { diff: string }) {
  const { c } = useTheme()
  const lines = clipText(diff).split('\n')
  return (
    <View style={{ borderRadius: radius.md, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, paddingVertical: 8, overflow: 'hidden' }} accessibilityLabel="Diff">
      {lines.map((l, i) => {
        const add = l.startsWith('+') && !l.startsWith('+++')
        const del = l.startsWith('-') && !l.startsWith('---')
        const meta = l.startsWith('@@') || l.startsWith('diff ') || l.startsWith('+++') || l.startsWith('---')
        return (
          <Text
            key={i}
            variant="mono"
            selectable
            style={{
              fontSize: 12, lineHeight: 17, paddingHorizontal: 10,
              color: add ? c.success : del ? c.danger : meta ? c.ink3 : c.ink2,
              backgroundColor: add ? c.successSoft : del ? c.dangerSoft : 'transparent',
            }}
          >
            {l || ' '}
          </Text>
        )
      })}
    </View>
  )
}

function Details({ a }: { a: Activity }) {
  const ws = useWorkspace()
  const input = a.input as Record<string, unknown> | null
  const output = a.output as Record<string, unknown> | null
  const copy = async (s: string) => { await Clipboard.setStringAsync(s); toast({ title: 'Copied' }) }

  let body
  if (a.type === 'sandbox' && a.name === 'run_shell') {
    const out = `$ ${input?.cmd ?? ''}\n${String(output?.result ?? '')}`.trim()
    body = <CodeBlock tone="terminal" label="Terminal" value={clipText(out)} onCopy={() => copy(out)} />
  } else if (a.type === 'sandbox' && a.name === 'diff' && typeof output?.diff === 'string') {
    body = <DiffBlock diff={output.diff} />
  } else if (a.name === 'COMPOSIO_MULTI_EXECUTE_TOOL' && Array.isArray(input?.tools)) {
    body = (
      <View style={{ gap: 14 }}>
        {(input.tools as { tool_slug?: string; arguments?: unknown }[]).map((t, i) => (
          <View key={i} style={{ gap: 8 }}>
            <Text variant="label" color="ink2">{t.tool_slug ?? 'Tool'}</Text>
            <KeyValues value={t.arguments} />
          </View>
        ))}
        {output && <Section title="Result"><KeyValues value={output} /></Section>}
      </View>
    )
  } else {
    body = (
      <View style={{ gap: 14 }}>
        {input && Object.keys(input).length > 0 && <Section title="Input"><KeyValues value={input} /></Section>}
        {output && Object.keys(output).length > 0 && <Section title={a.status === 'error' ? 'Error' : 'Output'}><KeyValues value={output} /></Section>}
        {!input && !output && <Text variant="caption" color="ink3">No details were recorded for this step.</Text>}
      </View>
    )
  }

  return (
    <View style={{ gap: 12, paddingTop: 4, paddingBottom: 12, paddingLeft: 56, paddingRight: 16 }}>
      {body}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Text variant="footnote" color="ink3" tabular style={{ flex: 1 }}>{fullTime(a.created_at)}</Text>
        {a.thread_id && ws.thread(a.thread_id) && (
          <Button
            label={`Open ${ws.threadTitle(a.thread_id)}`}
            size="sm"
            variant="soft"
            icon={ArrowUpRight01Icon}
            iconPosition="right"
            onPress={() => router.push({ pathname: '/chat/[threadId]', params: { threadId: a.thread_id! } })}
          />
        )}
      </View>
    </View>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text variant="overline" color="ink3">{title}</Text>
      {children}
    </View>
  )
}

/** One timeline row. Tap to expand input and output (accordion). */
export function ActivityRow({ a }: { a: Activity }) {
  const ws = useWorkspace()
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(false) // keep details mounted so closing animates
  const flip = useFlip(open)
  const tm = ws.teammate(a.teammate_id)
  const name = a.type === 'approval_decision' && !tm ? 'You' : tm?.name ?? 'A teammate'
  const sentence = describe(a, (id) => ws.teammate(id)?.name)
  const dur = durationLabel(a.duration_ms)
  const where = a.thread_id && ws.thread(a.thread_id) ? ws.threadTitle(a.thread_id) : null
  const meta = [ago(a.created_at), dur, where].filter(Boolean).join(' · ')
  const failed = a.status === 'error' || a.type === 'error'

  return (
    <View>
      <Press
        radius={radius.md}
        static
        onPress={() => { setSeen(true); setOpen((o) => !o) }}
        accessibilityLabel={`${name} ${sentence}. ${meta}${failed ? '. Failed' : a.status === 'pending' ? '. Waiting' : ''}`}
        accessibilityHint={open ? 'Hides the details' : 'Shows the details'}
        accessibilityState={{ expanded: open }}
        outerStyle={{ marginHorizontal: 4 }}
        style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'flex-start' }}
      >
        <View style={{ paddingTop: 1 }}>
          {tm ? <TeammateAvatar teammate={tm} size={32} interactive={false} paused /> : <View style={{ width: 32, height: 32 }} />}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text variant="body" numberOfLines={open ? undefined : 2}>
            <Text variant="bodyMedium">{name}</Text>
            <Text variant="body" color="ink2"> {sentence}</Text>
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text variant="footnote" color="ink3" tabular numberOfLines={1} style={{ flexShrink: 1 }}>{meta}</Text>
            {failed && <Chip label="Failed" tone="danger" />}
            {a.status === 'pending' && <Chip label="Waiting" tone="warning" />}
          </View>
        </View>
        <Animated.View style={[{ paddingTop: 3 }, flip]}>
          <Icon icon={ArrowDown01Icon} size={16} color="ink3" />
        </Animated.View>
      </Press>
      <Collapse open={open}>{seen ? <Details a={a} /> : <View />}</Collapse>
    </View>
  )
}
