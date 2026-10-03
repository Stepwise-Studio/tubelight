// A computer's info sheet (the (i) in its chat header): battery, disk, memory and CPU, the apps using memory right now
// (refreshed every 2 s while open), and quick actions that send its slash commands. Agent: computers.py `live`.
import { useEffect, useState } from 'react'
import { View } from 'react-native'

import { api } from '@/lib/api'
import { radius, useTheme } from '@/theme'
import { Button, Chip, Divider, ListRow, Sheet, Skeleton, Squircle, Text, confirm, haptic, toast } from '@/ui'

interface Live {
  stats: { disk?: number; mem?: number; load?: number; battery?: number; charging?: boolean }
  mem_total: number
  cpu_total: number
  apps: { name: string; mem: number; cpu: number; procs: number; closable?: boolean }[]
}

const ACTIONS = [
  { title: 'Status report', cmd: '/status' },
  { title: 'Biggest apps and folders', cmd: '/big' },
  { title: 'Clean up space', cmd: '/clean' },
  { title: 'Check for updates', cmd: '/update' },
  { title: 'Lock the screen', cmd: '/lock' },
]

const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)

export function ComputerInfo({ open, onClose, id, name, onCommand }: {
  open: boolean; onClose: () => void; id: string; name: string; onCommand: (cmd: string) => void
}) {
  const { c } = useTheme()
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => api<Live>(`/computers/${id}/live`).then(
      (d) => { if (alive) { setLive(d); setError(null) } },
      (e: Error) => { if (alive) setError(e.message) })
    load()
    const t = setInterval(load, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [open, id])

  const s = live?.stats ?? {}
  const tiles = [
    { label: 'Battery', value: s.battery != null ? `${s.battery}%` : '–', sub: s.charging ? 'Plugged in' : s.battery != null ? 'On battery' : '' },
    { label: 'Memory', value: s.mem != null ? `${s.mem}%` : '–', sub: live ? `of ${gb(live.mem_total)}` : '' },
    { label: 'Disk', value: s.disk != null ? `${s.disk}%` : '–', sub: 'used' },
    { label: 'CPU', value: live ? `${Math.round(live.cpu_total)}%` : '–', sub: 'right now' },
  ]
  const top = live?.apps[0]?.mem || 1
  const [closing, setClosing] = useState<string | null>(null)
  const close = async (app: string) => {
    if (!await confirm({ title: `Close ${app}?`, body: 'All its windows close. Anything unsaved in it may be lost.', confirmLabel: 'Close', destructive: true })) return
    setClosing(app)
    try {
      const { result } = await api<{ result: string }>(`/computers/${id}/apps/close`, { method: 'POST', json: { name: app } })
      haptic.success()
      toast({ title: result })
    } catch (e) {
      toast({ title: `Unable to close ${app}`, body: (e as Error).message, tone: 'error' })
    } finally { setClosing(null) }
  }

  return (
    <Sheet open={open} onClose={onClose} accessibilityLabel={`${name} details`}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 24, gap: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>{name}</Text>
          <Chip label={error ? 'Unreachable' : 'Live'} color={error ? 'warning' : 'success'} size="sm" dot />
        </View>
        {error && <Text variant="caption" color="ink3">{error}</Text>}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {tiles.map((t) => (
            <Squircle key={t.label} style={{ flexGrow: 1, flexBasis: '45%', borderRadius: radius.md, backgroundColor: c.panel2, padding: 12, gap: 2 }}>
              <Text variant="footnote" color="ink3">{t.label}</Text>
              {live ? <Text variant="heading" tabular>{t.value}</Text> : <Skeleton width={56} height={24} />}
              {!!t.sub && <Text variant="footnote" color="ink3">{t.sub}</Text>}
            </Squircle>
          ))}
        </View>

        <View style={{ gap: 10 }}>
          <Text variant="label" color="ink2">Memory by app</Text>
          {!live ? [0, 1, 2, 3].map((i) => <Skeleton key={i} height={28} />) : live.apps.slice(0, 8).map((a) => (
            <View key={a.name} style={{ gap: 4 }} accessible accessibilityLabel={`${a.name}, ${gb(a.mem)}, CPU ${a.cpu}%`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text variant="bodyMedium" numberOfLines={1} style={{ flex: 1 }}>{a.name}</Text>
                {a.cpu >= 1 && <Text variant="footnote" color="ink3" tabular>CPU {Math.round(a.cpu)}%</Text>}
                <Text variant="label" tabular style={{ minWidth: 64, textAlign: 'right' }}>{gb(a.mem)}</Text>
                {a.closable && <Button label="Close" variant="soft" size="sm" loading={closing === a.name} onPress={() => close(a.name)} />}
              </View>
              <View style={{ height: 5, borderRadius: 3, backgroundColor: c.panel2 }}>
                <View style={{ width: `${(a.mem / top) * 100}%`, height: '100%', borderRadius: 3, backgroundColor: c.tube }} />
              </View>
            </View>
          ))}
        </View>

        <View style={{ marginHorizontal: -12 }}>
          <Text variant="label" color="ink2" style={{ paddingHorizontal: 12, paddingBottom: 4 }}>Quick actions</Text>
          {ACTIONS.map((x, i) => (
            <View key={x.cmd}>
              {i > 0 && <Divider />}
              <ListRow title={x.title} subtitle={x.cmd} chevron onPress={() => { onClose(); onCommand(x.cmd) }} style={{ minHeight: 52 }} />
            </View>
          ))}
        </View>
      </View>
    </Sheet>
  )
}
