// A file's face when it has no picture: a soft tile in its type's colour with the extension, the way Linear and
// Notion badge files. Photos use their thumbnail instead (see Thumb).
import { Image } from 'expo-image'
import { memo } from 'react'
import { Text, View } from 'react-native'
import { Folder01Icon, MusicNote01Icon, PlayIcon } from '@hugeicons/core-free-icons'

import { kindOf, fileUrl, type FileKind, type VaultItem } from '@/lib/vault'
import { fonts, useTheme } from '@/theme'
import { Icon, Squircle } from '@/ui'

const TINT: Record<FileKind, string | null> = {
  pdf: '#e5484d', word: '#3e63dd', sheet: '#30a46c', slides: '#f76b15', audio: '#8e4ec6', video: '#0090ff',
  archive: '#d6a01d', image: '#12a594', markdown: null, text: null, other: null,
}

export function tintOf(item: Pick<VaultItem, 'name' | 'mime'>) {
  return TINT[kindOf(item.name, item.mime)]
}

export const FileTile = memo(function FileTile({ item, size = 44 }: { item: Pick<VaultItem, 'name' | 'mime'>; size?: number }) {
  const { c } = useTheme()
  const kind = kindOf(item.name, item.mime)
  const tint = TINT[kind] ?? c.ink2
  const ext = (item.name.includes('.') ? item.name.split('.').pop()! : kind).slice(0, 4).toUpperCase()
  return (
    <Squircle style={{
      width: size, height: size, borderRadius: size * 0.3, alignItems: 'center', justifyContent: 'center',
      backgroundColor: TINT[kind] ? `${tint}1f` : c.panel2, borderWidth: 1, borderColor: TINT[kind] ? `${tint}29` : c.line,
    }}>
      {kind === 'audio' ? <Icon icon={MusicNote01Icon} size={size * 0.42} color={tint} />
        : kind === 'video' ? <Icon icon={PlayIcon} size={size * 0.42} color={tint} />
          : <Text style={{ fontFamily: fonts.bold, fontSize: size * (ext.length > 3 ? 0.21 : 0.25), letterSpacing: 0.2, color: tint }}
            maxFontSizeMultiplier={1}>{ext}</Text>}
    </Squircle>
  )
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
