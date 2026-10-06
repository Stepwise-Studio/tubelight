// A file's face when it has no picture: a soft tile in its type's colour with the extension, the way Linear and
// Notion badge files. Photos use their thumbnail instead (see Thumb).
import { Image } from 'expo-image'
import { memo } from 'react'
import { View } from 'react-native'
import { Folder01Icon } from '@hugeicons/core-free-icons'

import { kindOf, fileUrl, type VaultItem } from '@/lib/vault'

import { FileIcon, KIND_COLOR } from './file-icon'
import { useTheme } from '@/theme'
import { Icon, Squircle } from '@/ui'

export function tintOf(item: Pick<VaultItem, 'name' | 'mime'>) {
  return KIND_COLOR[kindOf(item.name, item.mime)]
}

/** A file's face when it has no picture (see FileIcon). */
export const FileTile = memo(function FileTile({ item, size = 44 }: { item: Pick<VaultItem, 'name' | 'mime'>; size?: number }) {
  return <FileIcon name={item.name} mime={item.mime} size={size} />
})

/** A folder: a tab-topped shape tinted by its contents' colour (or the accent). */
export const FolderGlyph = memo(function FolderGlyph({ size = 44, tint }: { size?: number; tint?: string }) {
  const { c } = useTheme()
  const t = tint ?? c.tube
  return (
    <Squircle style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: `${t}1f`, alignItems: 'center', justifyContent: 'center' }}>
      <Icon icon={Folder01Icon} size={size * 0.5} color={t} strokeWidth={1.75} />
    </Squircle>
  )
})

/** A photo's thumbnail (or the photo itself), filling its box. */
export function Thumb({ item, style }: { item: VaultItem; style?: object }) {
  const { c } = useTheme()
  const src = item.thumb ?? (kindOf(item.name, item.mime) === 'image' && item.url ? item.url : null)
  if (!src) return <View style={[{ backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }, style]}><FileTile item={item} size={40} /></View>
  return <Image source={fileUrl(src)} recyclingKey={item.id} cachePolicy="disk" contentFit="cover" transition={150} style={[{ backgroundColor: c.panel2 }, style]} accessibilityIgnoresInvertColors />
}
