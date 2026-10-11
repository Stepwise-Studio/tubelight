// A row for a file or folder that isn't in the vault (Google Drive, the phone's own storage): picture or icon, name,
// size and date, and its ⋯.
import { Image } from 'expo-image'
import { View } from 'react-native'
import { ArrowRight01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons'

import { formatSize, kindOf } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Icon, IconButton, Press, Text } from '@/ui'

import { FileIcon, KIND_COLOR } from './file-icon'
import { FolderGlyph } from './file-tile'
import { Folder } from './folder'

export function OutsideRow({ name, mime = '', dir, size, date, thumb, meta, onPress, onMore }: {
  name: string; mime?: string; dir?: boolean; size?: number; date?: string | number; thumb?: string | null
  /** Instead of size · date (a folder's item count). */
  meta?: string
  onPress: () => void; onMore?: () => void
}) {
  const { c } = useTheme()
  const when = date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(date).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : ''
  const line = meta ?? [!dir && size ? formatSize(size) : '', when].filter(Boolean).join(' · ')
  const picture = thumb && !dir && ['image', 'video', 'pdf'].includes(kindOf(name, mime))
  return (
    <Press radius={0} onPress={onPress} onLongPress={onMore} accessibilityLabel={`${name}${dir ? ', folder' : ''}${line ? `, ${line}` : ''}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16, paddingRight: 6, paddingVertical: 8, minHeight: 64 }}>
      <View style={{ width: 48, alignItems: 'center' }}>
        {dir ? <FolderGlyph size={44} />
          : picture ? <Image source={thumb} style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: c.panel2 }} contentFit="cover" recyclingKey={thumb} />
            : <FileIcon name={name} mime={mime} size={46} glow={false} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{name}</Text>
        {!!line && <Text variant="footnote" color="ink3" tabular numberOfLines={1}>{line}</Text>}
      </View>
      {onMore ? <IconButton icon={MoreHorizontalIcon} size={40} iconSize={18} color={c.ink3} accessibilityLabel={`More for ${name}`} onPress={onMore} />
        : dir ? <View style={{ width: 40, alignItems: 'center' }}><Icon icon={ArrowRight01Icon} size={16} color="ink4" /></View> : null}
    </Press>
  )
}

/** The same, as a grid tile: a picture or a folder, otherwise the file's icon on a wash of its colour. */
export function OutsideTile({ name, mime = '', dir, thumb, size, onPress, onMore }: {
  name: string; mime?: string; dir?: boolean; thumb?: string | null; size: number; onPress: () => void; onMore?: () => void
}) {
  const { c, scheme } = useTheme()
  const kind = kindOf(name, mime)
  const picture = thumb && !dir && ['image', 'video', 'pdf'].includes(kind)
  return (
    // radius 0 and no wash: a rounded clip around the whole tile would cut into the name's first letter
    dir ? <Folder size={size} label={name} peek={2} onPress={onPress} /> : (
    <Press radius={0} wash={null} onPress={onPress} onLongPress={onMore} accessibilityLabel={name} style={{ width: size, gap: 6 }}>
      <View style={{ width: size, height: size, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
        backgroundColor: dir ? c.panel2 : `${KIND_COLOR[kind]}${scheme === 'dark' ? '24' : '14'}` }}>
        {dir ? <FolderGlyph size={size * 0.42} />
          : picture ? <Image source={thumb} style={{ width: size, height: size }} contentFit="cover" recyclingKey={thumb} />
            : <FileIcon name={name} mime={mime} size={Math.min(size * 0.5, 64)} glow={false} />}
      </View>
      <Text variant="footnote" numberOfLines={1} style={{ paddingHorizontal: 2 }}>{name}</Text>
    </Press>
    )
  )
}

/** Rows of tiles for a FlatList (`chunk(items, 3)`). */
export const chunk = <T,>(l: T[], n: number) => Array.from({ length: Math.ceil(l.length / n) }, (_, i) => l.slice(i * n, i * n + n))
