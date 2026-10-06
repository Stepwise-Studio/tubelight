// What a file looks like at a glance, for cards, grid tiles and rows: a photo or video frame, a PDF's first page
// (drawn on the phone once and kept), otherwise its icon on a wash of its colour.
import { Image } from 'expo-image'
import { memo, useEffect, useState } from 'react'
import { View, type ViewStyle } from 'react-native'
import { PlayIcon, StarIcon } from '@hugeicons/core-free-icons'

import { Phone } from '@/lib/phone'
import { fileUrl, kindOf, viewable, type VaultItem } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Icon, Text } from '@/ui'

import { localCopy } from './actions'
import { FileIcon, KIND_COLOR } from './file-icon'

const pages = new Map<string, string>()
let queue: Promise<unknown> = Promise.resolve()

/** A PDF's first page as an image (one at a time, so a folder of PDFs doesn't open them all at once). */
export function usePdfCover(item: VaultItem, width: number) {
  const pdf = kindOf(item.name, item.mime) === 'pdf'
  const [uri, setUri] = useState(pages.get(item.id))
  useEffect(() => {
    if (!pdf || uri || !item.url || !Phone?.pdfPage) return
    let live = true
    queue = queue.then(() => localCopy(viewable(item))
      .then((f) => Phone!.pdfPage(f.uri, 0, Math.round(width)))
      .then((p) => { pages.set(item.id, p.uri); if (live) setUri(p.uri) }, () => {}))
    return () => { live = false }
  }, [pdf, uri, item, width])
  return uri
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

export const FilePreview = memo(function FilePreview({ item, width, height, radius = 14, icon = 0.42, style }: {
  item: VaultItem; width: number; height: number; radius?: number; icon?: number; style?: ViewStyle
}) {
  const { c, scheme } = useTheme()
  const kind = kindOf(item.name, item.mime)
  const cover = usePdfCover(item, width * 2.4)
  const src = item.thumb ? fileUrl(item.thumb) : kind === 'image' && item.url ? fileUrl(item.url) : cover
  const tint = KIND_COLOR[kind]
  return (
    <View style={[{ width, height, borderRadius: radius, overflow: 'hidden', backgroundColor: c.panel2 }, style]}>
      {src ? (
        cover && !item.thumb
          // A page: shown whole across the top, on white, like paper.
          ? <View style={{ flex: 1, backgroundColor: scheme === 'dark' ? '#e9e9ec' : '#f4f4f5', alignItems: 'center', paddingTop: height * 0.08 }}>
              <Image source={cover} style={{ width: width * 0.84, height: width * 0.84 * 1.414, borderRadius: 3 }} contentFit="cover" transition={150} recyclingKey={item.id} />
            </View>
          : <Image source={src} style={{ flex: 1 }} contentFit="cover" transition={150} recyclingKey={item.id} cachePolicy="disk" />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: `${tint}${scheme === 'dark' ? '24' : '14'}` }}>
          <FileIcon name={item.name} mime={item.mime} size={Math.min(height * icon * 1.6, 84)} glow={height > 110} />
        </View>
      )}
      {kind === 'video' && (
        <View style={{ position: 'absolute', left: 6, bottom: 6, height: 22, paddingHorizontal: 7, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.55)', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon icon={PlayIcon} size={10} color="#fff" strokeWidth={2.4} />
          {!!item.meta?.duration && <Text variant="footnote" color="#fff" tabular style={{ fontSize: 11, lineHeight: 14 }}>{clock(item.meta.duration)}</Text>}
        </View>
      )}
      {item.starred && (
        <View style={{ position: 'absolute', right: 6, top: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={StarIcon} size={12} color="#ffd25e" strokeWidth={2.4} />
        </View>
      )}
    </View>
  )
})
