// Your computers (agent-service computers.py + runner/tubelight-runner.py): link one with a code, see what it shares,
// choose where builders' code runs and whether teammates may work in your folders. What a computer shares is set on
// the computer itself; this screen only shows it.
import * as Clipboard from 'expo-clipboard'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshControl, ScrollView, Share, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Copy01Icon, LaptopAddIcon, LaptopIcon, QrCode01Icon } from '@hugeicons/core-free-icons'

import { FormSection } from '@/components/form-bits'
import { ScreenHeader } from '@/components/screen-header'
import { BASE, api } from '@/lib/api'
import { ago, copied } from '@/lib/format'
import { useTheme } from '@/theme'
import { Button, IconButton, ListRow, RadioRow, Sheet, Skeleton, Surface, Text, Toggle, confirm, toast } from '@/ui'

interface Computer {
  id: string; name: string; os: string | null; online: boolean; last_seen: number | null
  folders: string[]; docker: boolean; shell: boolean; version: string | null
}
type CodeOn = 'server' | 'computer' | 'auto'
interface Data { computers: Computer[]; code_on: CodeOn; cowork: boolean }

const RUNNER = 'python3 ~/tubelight-runner.py'

export default function ComputersScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [data, setData] = useState<Data | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [linking, setLinking] = useState(false)
  const [open, setOpen] = useState<Computer | null>(null)
  const load = useCallback(() => api<Data>('/computers').then(setData, (e: Error) => {
    setData((d) => d ?? { computers: [], code_on: 'auto', cowork: true })
    toast({ title: 'Unable to load computers', body: e.message, tone: 'error' })
  }), [])
  useFocusEffect(useCallback(() => { load() }, [load]))

  const change = async (patch: Partial<Pick<Data, 'code_on' | 'cowork'>>) => {
    setData((d) => d && { ...d, ...patch })
    try {
      await api('/computers/prefs', { method: 'PATCH', json: patch })
    } catch (e) {
      toast({ title: 'Unable to save that', body: (e as Error).message, tone: 'error' })
      load()
    }
  }

  const list = data?.computers ?? []
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Computers" subtitle="Let teammates work on your own machines" />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
      >
        <FormSection title="Linked" hint="A computer is reachable while the Tubelight runner runs on it. It connects out to your server; nothing on it is opened to the internet.">
          <Surface style={{ overflow: 'hidden' }}>
            {data === null ? (
              <View style={{ padding: 16, gap: 10 }}><Skeleton width="45%" /><Skeleton width="70%" /></View>
            ) : list.map((m) => (
              <ListRow key={m.id} title={m.name} icon={LaptopIcon} chevron onPress={() => setOpen(m)}
                subtitle={[m.online ? 'Online' : m.last_seen ? `Last seen ${ago(new Date(m.last_seen * 1000).toISOString()).toLowerCase()}` : 'Not running',
                  m.online && `${m.folders.length} shared folder${m.folders.length === 1 ? '' : 's'}`, m.online && m.docker && 'sandboxes'].filter(Boolean).join(' · ')}
                accessory={<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: m.online ? c.success : c.ink4 }} />} />
            ))}
            <ListRow title={list.length ? 'Link another computer' : 'Link a computer'} icon={LaptopAddIcon} onPress={() => setLinking(true)} />
          </Surface>
        </FormSection>

        {data && (
          <FormSection title="Where builders run code" hint="Developers and testers run code in a throwaway sandbox. Your computer needs Docker for this.">
            <Surface style={{ overflow: 'hidden', paddingVertical: 4 }}>
              <View accessibilityRole="radiogroup">
                <RadioRow title="Automatic" subtitle="Your home server; your computer when the server can’t" subtitleLines={2} checked={data.code_on === 'auto'} onPress={() => change({ code_on: 'auto' })} />
                <RadioRow title="Home server" subtitle="Always the server" checked={data.code_on === 'server'} onPress={() => change({ code_on: 'server' })} />
                <RadioRow title="Your computer" subtitle="When it’s online, else the server" checked={data.code_on === 'computer'} onPress={() => change({ code_on: 'computer' })} />
              </View>
            </Surface>
          </FormSection>
        )}

        {data && (
          <FormSection title="Cowork" hint="Teammates read the folders your computer shares on their own. Every file they change and every command they run waits for your approval.">
            <Surface padding={16}>
              <Toggle value={data.cowork} onChange={(cowork) => change({ cowork })} label="Let teammates work in shared folders" />
            </Surface>
          </FormSection>
        )}
      </ScrollView>
      <LinkSheet open={linking} known={list.map((m) => m.id)} onClose={() => { setLinking(false); load() }} />
      <ComputerSheet m={open} onClose={() => setOpen(null)} onRemoved={() => { setOpen(null); load() }} />
    </View>
  )
}

function Command({ text }: { text: string }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.panel2, borderRadius: 12, paddingLeft: 12, paddingVertical: 4, paddingRight: 4 }}>
      <Text variant="mono" style={{ flex: 1 }} selectable>{text}</Text>
      <IconButton icon={Copy01Icon} accessibilityLabel="Copy command" onPress={async () => { await Clipboard.setStringAsync(text); copied() }} />
    </View>
  )
}

/** How to link: install Tubelight for desktop, open it, scan its code. A command (with a one-time code) is the way
 * for computers the desktop app doesn't cover yet (Mac, other Linux). */
function LinkSheet({ open, known, onClose }: { open: boolean; known: string[]; onClose: () => void }) {
  const { c } = useTheme()
  const [other, setOther] = useState(false)
  const [pair, setPair] = useState<{ code: string; command: string; until: number } | null>(null)
  const [linked, setLinked] = useState<Computer | null>(null)
  const knownRef = useRef(known)
  useEffect(() => { knownRef.current = known }, [known])
  const desktop = `${BASE.replace(/\/$/, '')}/desktop`

  useEffect(() => {
    if (!open || !other) return
    api<{ code: string; command: string; expires_in: number }>('/computers/pair', { method: 'POST' })
      .then((p) => setPair({ ...p, until: Date.now() + p.expires_in * 1000 }), (e: Error) => toast({ title: 'Unable to get a code', body: e.message, tone: 'error' }))
  }, [open, other])

  useEffect(() => {  // a computer linked with the command appears in the list
    if (!pair || linked) return
    const t = setInterval(() => {
      if (Date.now() > pair.until) { clearInterval(t); return }
      api<Data>('/computers').then((d) => {
        const fresh = d.computers.find((m) => !knownRef.current.includes(m.id))
        if (fresh) setLinked(fresh)
      }, () => {})
    }, 3000)
    return () => clearInterval(t)
  }, [pair, linked])

  const close = () => { setPair(null); setLinked(null); setOther(false); onClose() }
  const step = (n: number, title: string, body: React.ReactNode) => (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
        <Text variant="label" color="ink2">{n}</Text>
      </View>
      <View style={{ flex: 1, gap: 8 }}>
        <Text variant="bodyMedium">{title}</Text>
        {body}
      </View>
    </View>
  )
  return (
    <Sheet open={open} onClose={close} title={linked ? `Linked ${linked.name}` : 'Link a computer'}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 24, gap: 18 }}>
        {linked ? (
          <>
            <Text variant="body" color="ink2">Share a folder on it so teammates can work there:</Text>
            <Command text={`${RUNNER} allow ~/path/to/folder`} />
            <Button label="Done" onPress={close} />
          </>
        ) : !other ? (
          <>
            {step(1, 'Install Tubelight on the computer', (
              <>
                <Text variant="caption" color="ink3">On the computer, open this page and download it (Ubuntu or Debian):</Text>
                <Command text={desktop} />
                <Button label="Send the link to myself" variant="soft" size="sm" style={{ alignSelf: 'flex-start' }}
                  onPress={() => Share.share({ message: `Tubelight for desktop: ${desktop}` })} />
              </>
            ))}
            {step(2, 'Open it and scan its code', (
              <Text variant="caption" color="ink3">Tubelight on the computer shows a QR code. Confirm on both, and it’s linked.</Text>
            ))}
            <Button label="Scan code" icon={QrCode01Icon} onPress={() => { close(); router.push('/scan') }} />
            <Button label="Mac or other Linux? Link with a command" variant="ghost" size="sm" onPress={() => setOther(true)} />
          </>
        ) : (
          <>
            <Text variant="body" color="ink2">On the computer (Python 3.10+), run this in a terminal. The code works once, for 10 minutes.</Text>
            {pair ? <Command text={pair.command} /> : <Skeleton height={44} />}
            <Text variant="footnote" color="ink3">This page notices when it’s linked.</Text>
          </>
        )}
      </View>
    </Sheet>
  )
}

function ComputerSheet({ m, onClose, onRemoved }: { m: Computer | null; onClose: () => void; onRemoved: () => void }) {
  const remove = async () => {
    if (!m || !(await confirm({ title: `Remove ${m.name}?`, body: 'Teammates lose access right away. Link it again with a new code.', confirmLabel: 'Remove', destructive: true }))) return
    try {
      await api(`/computers/${m.id}`, { method: 'DELETE' })
      onRemoved()
    } catch (e) {
      toast({ title: 'Unable to remove it', body: (e as Error).message, tone: 'error' })
    }
  }
  return (
    <Sheet open={!!m} onClose={onClose} title={m?.name ?? ''}>
      {m && (
        <View style={{ paddingHorizontal: 20, paddingBottom: 24, gap: 14 }}>
          <Text variant="caption" color="ink3">{[m.online ? 'Online' : 'Offline', m.os, m.docker ? 'Docker for sandboxes' : 'No Docker (no sandboxes)', m.shell ? null : 'Commands need bubblewrap'].filter(Boolean).join(' · ')}</Text>
          <Text variant="label">Shared folders</Text>
          {m.folders.length ? m.folders.map((f) => <Text key={f} variant="mono" selectable>{f}</Text>)
            : <Text variant="body" color="ink2">{m.online ? 'Nothing shared yet.' : 'Shown while it’s online.'}</Text>}
          <Text variant="footnote" color="ink3">Share or stop sharing folders in Tubelight on the computer (or with `{RUNNER.split(' ')[1]} allow` there).</Text>
          <Button label="Remove this computer" variant="destructive" onPress={remove} />
        </View>
      )}
    </Sheet>
  )
}
