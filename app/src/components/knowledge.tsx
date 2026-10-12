import * as DocumentPicker from 'expo-document-picker'
import { useCallback, useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { ArrowLeft01Icon, ArrowRight01Icon, Folder01Icon, LibraryIcon, Upload04Icon } from '@hugeicons/core-free-icons'

import { openItem } from '@/components/vault/actions'
import { FileIcon } from '@/components/vault/file-icon'
import { api } from '@/lib/api'
import type { Teammate } from '@/lib/types'
import { byFolderThenNewest, newFolder, uploadFiles, useVault, type VaultItem } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Button, Divider, Icon, IconButton, ListRow, Press, SelectDot, Sheet, Skeleton, Surface, Text, haptic, showMenu, toast } from '@/ui'

/** GET /teammates/:id/knowledge: what it was given (Vault rows) and how reading each file went. */
interface KnowledgeState {
  links: VaultItem[]
  files: { id: string; name: string; reading: boolean; chunks: number; error: string | null }[]
}

function useKnowledge(teammateId: string) {
  const [k, setK] = useState<KnowledgeState | null>(null)
  const load = useCallback(() => api<KnowledgeState>(`/teammates/${teammateId}/knowledge`).then(setK, () => {}), [teammateId])
  useEffect(() => { load() }, [load])
  // While something is being read, check again every few seconds.
  const reading = !!k?.files.some((f) => f.reading)
  useEffect(() => {
    if (!reading) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [reading, load])
  const save = async (links: string[]) => {
    try { setK(await api<KnowledgeState>(`/teammates/${teammateId}/knowledge`, { method: 'PUT', json: { links } })) } catch (e) {
      toast({ title: 'Unable to update', body: (e as Error).message, tone: 'error' })
    }
  }
  return { k, load, save }
}

/** How one link is doing: a file's own state, or a folder's files summed up. */
function statusOf(link: VaultItem, k: KnowledgeState, all: VaultItem[]) {
  const under = (id: string) => {
    for (let at = all.find((r) => r.id === id); at; at = all.find((r) => r.id === at!.parent)) if (at.id === link.id) return true
    return false
  }
  const files = k.files.filter((f) => (link.kind === 'file' ? f.id === link.id : under(f.id)))
  const reading = files.filter((f) => f.reading).length
  const failed = files.filter((f) => f.error)
  if (link.kind === 'file') {
    const f = files[0]
    return { text: !f || f.reading ? 'Reading…' : f.error ?? `Read · ${f.chunks} ${f.chunks === 1 ? 'passage' : 'passages'}`, live: !f || f.reading, bad: !!f?.error }
  }
  const n = files.length
  return {
    text: reading ? `Reading ${reading} of ${n}…` : `${n} ${n === 1 ? 'file' : 'files'}${failed.length ? ` · ${failed.length} unreadable` : ''}`,
    live: reading > 0, bad: false,
  }
}

/**
 * The files a teammate knows (its knowledge base, agent knowledge.py): Vault files and folders it reads from and
 * quotes with file and page. "Upload notes" files into its own Vault folder, linked once, so later uploads count too.
 */
export function KnowledgeSection({ t }: { t: Teammate }) {
  const { c } = useTheme()
  const { k, save } = useKnowledge(t.id)
  const { items } = useVault()
  const [picking, setPicking] = useState(false)
  const [pickN, setPickN] = useState(0)  // a fresh picker (trail, ticks) each time it opens
  const all = items ?? []
  const linked = k?.links.map((l) => all.find((r) => r.id === l.id) ?? l) ?? []

  const upload = async () => {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (r.canceled || !k) return
    try {
      const name = `${t.name}’s notes`
      const folder = all.find((x) => x.kind === 'folder' && x.parent === '' && x.name === name) ?? await newFolder(name, '')
      if (!k.links.some((l) => l.id === folder.id)) await save([...k.links.map((l) => l.id), folder.id])
      toast({ title: `Uploading to ${name}` })
      const res = await uploadFiles(r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? undefined, size: a.size ?? undefined })), folder.id)
      if (res.failed) toast({ title: `${res.failed} ${res.failed === 1 ? 'file' : 'files'} didn’t upload`, tone: 'error' })
      await save([...new Set([...k.links.map((l) => l.id), folder.id])])  // reads what just arrived
    } catch (e) {
      toast({ title: 'Unable to upload', body: (e as Error).message, tone: 'error' })
    }
  }
  const add = () => showMenu({
    title: `Give ${t.name} something to know`,
    items: [
      { label: 'Upload notes', icon: Upload04Icon, onPress: upload },
      { label: 'Choose from your Vault', icon: LibraryIcon, onPress: () => { setPickN((n) => n + 1); setPicking(true) } },
    ],
  })

  return (
    <View style={{ gap: 12 }}>
      <SectionHead title="Knows" hint={`Notes and files ${t.name} reads from, and quotes by page.`}
        action={<Button label="Add" size="sm" variant="soft" onPress={add} />} />
      {k === null ? (
        <Surface padding={16} style={{ gap: 10 }}><Skeleton width="60%" /><Skeleton width="40%" /></Surface>
      ) : linked.length === 0 ? (
        <Press radius={16} onPress={add} style={{ padding: 16, borderWidth: 1, borderColor: c.line, borderStyle: 'dashed', flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
            <Icon icon={LibraryIcon} size={20} color="ink2" />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium">Hand over your notes</Text>
            <Text variant="caption" color="ink3">PDFs, docs or photos of pages. Then ask “what does chapter 3 say about…”.</Text>
          </View>
        </Press>
      ) : (
        <Surface style={{ overflow: 'hidden' }}>
          {linked.map((l, i) => {
            const s = statusOf(l, k, all)
            return (
              <View key={l.id}>
                {i > 0 && <Divider inset={64} />}
                <ListRow
                  title={l.name}
                  subtitle={s.text}
                  leading={l.kind === 'folder'
                    ? <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}><Icon icon={Folder01Icon} size={20} color="ink2" /></View>
                    : <FileIcon name={l.name} mime={l.mime} size={40} />}
                  accessory={s.live ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.color || c.tube }} /> : undefined}
                  onPress={() => openItem(l)}
                  onLongPress={() => { haptic.light(); showMenu({ title: l.name, items: [
                    { label: `Take back from ${t.name}`, icon: ArrowLeft01Icon, destructive: true, onPress: () => save(k.links.filter((x) => x.id !== l.id).map((x) => x.id)) },
                  ] }) }}
                  accessibilityHint="Opens it. Long press to take it back"
                />
              </View>
            )
          })}
        </Surface>
      )}
      {k && <VaultPicker key={pickN} open={picking} onClose={() => setPicking(false)} chosen={k.links.map((l) => l.id)} name={t.name}
        onDone={(ids) => { setPicking(false); save(ids) }} />}
    </View>
  )
}

/** A section title with a hint and an action on the right (the profile's sections). */
export function SectionHead({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="heading">{title}</Text>
        {!!hint && <Text variant="caption" color="ink3">{hint}</Text>}
      </View>
      {action}
    </View>
  )
}

/** Walk the Vault and tick files and folders to hand over (a folder brings what's in it, now and later). */
function VaultPicker({ open, onClose, chosen, name, onDone }: { open: boolean; onClose: () => void; chosen: string[]; name: string; onDone: (ids: string[]) => void }) {
  const { items } = useVault()
  const [trail, setTrail] = useState<VaultItem[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set(chosen))
  const here = trail.at(-1)
  const rows = (items ?? []).filter((r) => r.parent === (here?.id ?? '') && !r.meta?.hidden).sort(byFolderThenNewest)
  const toggle = (id: string) => { haptic.tap(); setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n }) }
  const added = [...picked].filter((x) => !chosen.includes(x)).length
  return (
    <Sheet open={open} onClose={onClose} title={here ? here.name : 'Your Vault'}>
      <View style={{ paddingBottom: 16, gap: 8 }}>
        {here && (
          <View style={{ paddingHorizontal: 12 }}>
            <IconButton icon={ArrowLeft01Icon} accessibilityLabel="Back" onPress={() => setTrail((t) => t.slice(0, -1))} />
          </View>
        )}
        <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ paddingHorizontal: 12 }}>
          {items === null ? <View style={{ padding: 12, gap: 10 }}><Skeleton width="70%" /><Skeleton width="50%" /></View>
            : rows.length === 0 ? <Text variant="caption" color="ink3" style={{ padding: 12 }}>Nothing here.</Text>
              : rows.map((r) => (
                <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Press radius={12} onPress={() => toggle(r.id)} accessibilityLabel={`${r.name}${picked.has(r.id) ? ', chosen' : ''}`}
                    style={{ paddingHorizontal: 8, minHeight: 52, justifyContent: 'center' }}>
                    <SelectDot on={picked.has(r.id)} />
                  </Press>
                  <Press radius={12} static onPress={() => (r.kind === 'folder' ? setTrail((t) => [...t, r]) : toggle(r.id))}
                    outerStyle={{ flex: 1 }} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingRight: 8 }}>
                    {r.kind === 'folder' ? <Icon icon={Folder01Icon} size={22} color="ink2" /> : <FileIcon name={r.name} mime={r.mime} size={28} />}
                    <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>{r.name}</Text>
                    {r.kind === 'folder' && <Icon icon={ArrowRight01Icon} size={16} color="ink3" />}
                  </Press>
                </View>
              ))}
        </ScrollView>
        <View style={{ paddingHorizontal: 20 }}>
          <Button label={added ? `Give ${name} ${added} more` : 'Done'} fullWidth size="lg" onPress={() => onDone([...picked])} />
        </View>
      </View>
    </Sheet>
  )
}
