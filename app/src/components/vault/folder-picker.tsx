// "Move to…" for places outside the vault (Google Drive, the phone): walk the folders in a sheet and move the chosen
// things into the one you're in. Where to look comes from `load`; the vault itself has its own move sheet.
import { useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons'

import { useTheme } from '@/theme'
import { Button, IconButton, Sheet, Skeleton, Text } from '@/ui'

import { OutsideRow } from './outside-row'

export interface PickerDir { id: string; name: string }

export function FolderPicker({ open, title, root, load, disabled, onPick, onClose }: {
  open: boolean
  title: string
  /** Where it starts: the place's top. */
  root: PickerDir
  /** The folders inside one. */
  load: (id: string) => Promise<PickerDir[]>
  /** Folders you can't move into (the things being moved, or where they already are). */
  disabled?: (id: string) => boolean
  onPick: (dir: PickerDir) => void
  onClose: () => void
}) {
  const { c } = useTheme()
  const [trail, setTrail] = useState<PickerDir[]>([root])
  const [dirs, setDirs] = useState<PickerDir[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const here = trail[trail.length - 1]
  useEffect(() => {
    if (!open) return
    let live = true
    load(here.id).then((d) => { if (live) { setDirs(d); setError(null) } }, (e) => live && setError((e as Error).message))
    return () => { live = false }
  }, [open, here.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const go = (t: PickerDir[]) => { setDirs(null); setTrail(t) }
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <View style={{ paddingBottom: 16, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, minHeight: 40 }}>
          {trail.length > 1 && <IconButton icon={ArrowLeft01Icon} size={36} iconSize={18} color={c.ink2} accessibilityLabel="Up one folder" onPress={() => go(trail.slice(0, -1))} />}
          <Text variant="label" color="ink2" numberOfLines={1} style={{ flex: 1, paddingLeft: trail.length > 1 ? 0 : 8 }}>{trail.map((t) => t.name).join(' / ')}</Text>
        </View>
        <ScrollView style={{ maxHeight: 380 }}>
          {!dirs && !error && <View style={{ paddingHorizontal: 16, gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={48} radius={12} />)}</View>}
          {error && <Text variant="caption" color="danger" style={{ paddingHorizontal: 20 }}>{error}</Text>}
          {dirs?.length === 0 && <Text variant="caption" color="ink3" style={{ paddingHorizontal: 20, paddingVertical: 8 }}>No folders inside.</Text>}
          {dirs?.filter((d) => !disabled?.(d.id)).map((d) => <OutsideRow key={d.id} name={d.name} dir onPress={() => go([...trail, d])} />)}
        </ScrollView>
        <View style={{ paddingHorizontal: 20 }}>
          <Button label={`Move to ${here.name}`} size="lg" fullWidth disabled={disabled?.(here.id)} onPress={() => { onClose(); onPick(here) }} />
        </View>
      </View>
    </Sheet>
  )
}
