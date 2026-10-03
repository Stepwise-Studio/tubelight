// Usage: how much of each free allowance is left (agent-service usage.py). Models reset daily, Composio monthly.
import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ScreenHeader } from '@/components/screen-header'
import { TickMeter } from '@/components/tick-meter'
import { api } from '@/lib/api'
import { PROVIDERS, modelName, toolkitName, useModels } from '@/lib/catalog'
import { ago } from '@/lib/format'
import { useTheme } from '@/theme'
import { Collapse, Press, Skeleton, Surface, Text, toast } from '@/ui'

interface UsageItem {
  id: string
  provider: string
  used: number
  limit: number | null
  unit: string
  period: string
  resets?: string
  /** provider: the provider's own numbers; counted: Tubelight counts them (Gemini says nothing). */
  source: 'provider' | 'counted'
  note?: string
  out?: boolean
  breakdown?: { name: string; value: number }[]
}
interface Usage { updated: string; sections: { title: string; items: UsageItem[] }[] }

const COLOR: Record<string, string> = {
  gemini: '#3b82f6', groq: '#f97316', openrouter: '#8b5cf6', cloudflare: '#f59e0b', mistral: '#ef4444',
  composio: '#10b981', supabase: '#14b8a6',
}
const HINT: Record<string, string> = {
  Models: 'Free requests a day for each model. When one runs out, teammates switch to the next.',
  'Shared allowances': 'Daily pools that several models draw from.',
  Images: 'Pictures teammates make for you.',
  Apps: 'Every app action a teammate takes is a tool call.',
  Storage: 'Chats, memory and history.',
}

const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 }))

/** "in 3 h", "in 12 min", "on 1 Oct": when an allowance comes back. */
function resetsIn(iso: string) {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'soon'
  const h = ms / 3_600_000
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`
  if (h < 36) return `in ${Math.round(h)} h`
  return `on ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

export default function UsageScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [data, setData] = useState<Usage | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const load = useCallback(() => api<Usage>('/usage').then(setData, (e: Error) => {
    setData((d) => d ?? { updated: '', sections: [] })
    toast({ title: 'Unable to load usage', body: e.message, tone: 'error' })
  }), [])
  useFocusEffect(useCallback(() => { load() }, [load]))

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Usage" subtitle={data?.updated ? `Free allowances · updated ${ago(data.updated).toLowerCase()}` : 'Free allowances'} />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
      >
        {data === null ? (
          [0, 1].map((i) => <Surface key={i} padding={16} style={{ gap: 14 }}><Skeleton width="50%" /><Skeleton height={18} /><Skeleton width="40%" /><Skeleton height={18} /></Surface>)
        ) : data.sections.map((s) => (
          <Surface key={s.title} style={{ overflow: 'hidden' }}>
            <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, gap: 2, borderBottomWidth: 1, borderBottomColor: c.line }}>
              <Text variant="label">{s.title}</Text>
              {HINT[s.title] && <Text variant="footnote" color="ink3">{HINT[s.title]}</Text>}
            </View>
            {s.items.map((it, i) => <Row key={it.id} it={it} first={i === 0} />)}
          </Surface>
        ))}
        {data && data.sections.length > 0 && (
          <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 4 }}>
            Numbers come from each provider where it reports them. Gemini doesn’t, so Tubelight counts its requests (from when counting began); Google’s real limits show in AI Studio.
          </Text>
        )}
      </ScrollView>
    </View>
  )
}

function Row({ it, first }: { it: UsageItem; first: boolean }) {
  const { c } = useTheme()
  const { models } = useModels()
  const [open, setOpen] = useState(false)
  const color = COLOR[it.provider] ?? c.tube
  const name = it.id === 'composio' ? 'Composio tool calls' : it.id === 'database' ? 'Database'
    : it.id === 'openrouter' ? 'OpenRouter free models' : it.id === 'cloudflare' ? 'Cloudflare Workers AI' : modelName(it.id, models)
  const sub = it.id.includes(':') ? PROVIDERS[it.provider] ?? it.provider : it.id === 'database' ? 'Supabase' : null
  const share = it.limit ? it.used / it.limit : null
  const out = it.out || (it.limit != null && it.used >= it.limit)
  const amount = it.limit != null ? `${num(it.used)} / ${num(it.limit)} ${it.unit}` : `${num(it.used)} ${it.unit}${it.period ? ` ${it.period}` : ''}`
  const status = out ? `Used up · back ${it.resets ? resetsIn(it.resets) : 'soon'}`
    : [it.limit != null && it.period && `${num(Math.max(0, it.limit - it.used))} left ${it.period}`, it.resets && `resets ${resetsIn(it.resets)}`].filter(Boolean).join(' · ')
  const lines = [status, it.note, it.source === 'counted' && !it.note ? 'Counted by Tubelight' : ''].filter(Boolean) as string[]
  const body = (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8, borderTopWidth: first ? 0 : 1, borderTopColor: c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ flexShrink: 1 }}>{name}</Text>
          {sub && <Text variant="footnote" color="ink3" numberOfLines={1}>{sub}</Text>}
        </View>
        <Text variant="footnote" color={out ? 'danger' : 'ink2'} style={{ fontVariant: ['tabular-nums'] }}>{amount}</Text>
      </View>
      <TickMeter value={share} color={out ? c.danger : color} />
      {lines.map((l) => <Text key={l} variant="footnote" color={out && l === status ? 'danger' : share != null && share > 0.8 && l === status ? 'warning' : 'ink3'}>{l}</Text>)}
      {it.breakdown && (
        <Collapse open={open}>
          <View style={{ gap: 8, paddingTop: 4 }}>
            {it.breakdown.map((b) => (
              <View key={b.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text variant="footnote" color="ink2" style={{ width: 110 }} numberOfLines={1}>{b.name === 'Tool lookups' ? b.name : toolkitName(b.name)}</Text>
                <View style={{ flex: 1 }}><TickMeter value={b.value / Math.max(1, it.breakdown![0].value)} color={color} height={10} /></View>
                <Text variant="footnote" color="ink3" style={{ width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] }}>{num(b.value)}</Text>
              </View>
            ))}
          </View>
        </Collapse>
      )}
    </View>
  )
  if (!it.breakdown?.length) return <View accessible accessibilityLabel={`${name}, ${amount}. ${lines.join('. ')}`}>{body}</View>
  return (
    <Press radius={0} static onPress={() => setOpen((o) => !o)} accessibilityLabel={`${name}, ${amount}. ${lines.join('. ')}`}
      accessibilityHint={open ? 'Hides the breakdown by app' : 'Shows the breakdown by app'} accessibilityState={{ expanded: open }}>
      {body}
      {!open && <Text variant="footnote" color="tube" style={{ paddingHorizontal: 16, marginTop: -6, paddingBottom: 12 }}>By app</Text>}
    </Press>
  )
}
