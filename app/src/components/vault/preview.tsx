// What a file looks like at a glance, for cards, grid tiles and rows: a photo or video frame, a PDF's first page
// (drawn on the phone once and kept), a document's first lines, a sheet's first rows or a deck's first slide (from the
// server's preview, fetched once), otherwise its icon on a wash of its colour.
import { Image } from 'expo-image'
import { memo, useEffect, useState } from 'react'
import { View, type ViewStyle } from 'react-native'
import { PlayIcon, StarIcon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
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

type Doc =
  | { type: 'markdown'; text: string }
  | { type: 'sheets'; sheets: { rows: string[][] }[] }
  | { type: 'slides'; slides: { title?: string; subtitle?: string }[] }
  | { type: 'none' | 'error' }
const docs = new Map<string, Doc>()
let docQueue: Promise<unknown> = Promise.resolve()
const DOC_KINDS = new Set(['word', 'markdown', 'text', 'sheet', 'slides'])

/** A document's preview (Word, Markdown, sheets, slides), one fetch at a time and kept for the session. */
function useDoc(item: VaultItem, on: boolean) {
  const [doc, setDoc] = useState(docs.get(item.id))
  useEffect(() => {
    if (!on || doc || item.size > 15e6) return
    let live = true
    docQueue = docQueue.then(() => api<Doc | { type: 'doc'; blocks: { k: string; h?: number; runs?: { t?: string }[] }[] }>(`/vault/${item.id}/preview`)
      .then((raw) => {
        // A formatted Word document reads as its first lines on a cover (headings marked as such).
        const d: Doc = raw.type === 'doc'
          ? { type: 'markdown', text: raw.blocks.filter((b) => b.k === 'p').slice(0, 30).map((b) => (b.h !== undefined ? '# ' : '') + (b.runs ?? []).map((r) => r.t ?? '').join('')).join('\n') }
          : raw
        docs.set(item.id, d)
        if (live) setDoc(d)
      }, () => {}))
    return () => { live = false }
  }, [on, doc, item.id, item.size])
  return doc
}

/** A document's first page, drawn small: lines of text, a sheet's first rows, or a deck's title slide. */
function DocFace({ doc, width, height, tint }: { doc: Doc; width: number; height: number; tint: string }) {
  const { scheme } = useTheme()
  const paper = scheme === 'dark' ? '#e9e9ec' : '#f8f8f9'
  const f = Math.max(5, Math.min(9, width / 18))
  if (doc.type === 'slides' && doc.slides[0]) {
    const s = doc.slides[0]
    return (
      <View style={{ flex: 1, backgroundColor: paper, alignItems: 'center', justifyContent: 'center', padding: width * 0.08 }}>
        <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#fff', borderRadius: 3, borderTopWidth: 3, borderTopColor: tint, padding: 6, justifyContent: 'center',
          shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text numberOfLines={2} style={{ fontSize: f * 1.15, lineHeight: f * 1.4, fontWeight: '600', color: '#18181b', textAlign: 'center' }}>{s.title || 'Untitled'}</Text>
          {!!s.subtitle && <Text numberOfLines={1} style={{ fontSize: f * 0.85, lineHeight: f * 1.1, color: '#71717a', textAlign: 'center' }}>{s.subtitle}</Text>}
        </View>
      </View>
    )
  }
  if (doc.type === 'sheets' && doc.sheets[0]?.rows.length) {
    const rows = doc.sheets[0].rows.slice(0, Math.floor(height / (f * 2.2)))
    return (
      <View style={{ flex: 1, backgroundColor: '#fff', paddingTop: 2 }}>
        {rows.map((r, i) => (
          <View key={i} style={{ flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e4e4e7', backgroundColor: i === 0 ? `${tint}22` : undefined }}>
            {r.slice(0, 4).map((cell, j) => (
              <Text key={j} numberOfLines={1} style={{ flex: 1, fontSize: f, lineHeight: f * 2, paddingHorizontal: 2, color: '#3f3f46', fontWeight: i === 0 ? '600' : '400',
                borderRightWidth: 0.5, borderRightColor: '#e4e4e7' }}>{cell}</Text>
            ))}
          </View>
        ))}
      </View>
    )
  }
  if (doc.type === 'markdown' && doc.text.trim()) {
    const lines = doc.text.split('\n').map((l) => l.trim()).filter((l) => l && !/^[-|: ]+$/.test(l)).slice(0, 14)
    return (
      <View style={{ flex: 1, backgroundColor: paper, padding: width * 0.09, gap: f * 0.35, overflow: 'hidden' }}>
        {lines.map((l, i) => {
          const head = /^#{1,3}\s/.test(l)
          return (
            <Text key={i} numberOfLines={head ? 1 : 2} style={{ fontSize: head ? f * 1.25 : f, lineHeight: (head ? f * 1.25 : f) * 1.3, fontWeight: head ? '600' : '400', color: head ? '#18181b' : '#52525b' }}>
              {l.replace(/^#{1,6}\s+|^[-*+]\s+|^\d+\.\s+|[*_`>|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1')}
            </Text>
          )
        })}
      </View>
    )
  }
  return null
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

export const FilePreview = memo(function FilePreview({ item, width, height, radius = 14, icon = 0.42, style }: {
  item: VaultItem; width: number; height: number; radius?: number; icon?: number; style?: ViewStyle
}) {
  const { c, scheme } = useTheme()
  const kind = kindOf(item.name, item.mime)
  const cover = usePdfCover(item, width * 2.4)
  const doc = useDoc(item, DOC_KINDS.has(kind) && width >= 40)
  const face = doc && doc.type !== 'none' && doc.type !== 'error' ? doc : null
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
      ) : face ? (
        <DocFace doc={face} width={width} height={height} tint={tint} />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: `${tint}${scheme === 'dark' ? '24' : '14'}` }}>
          <FileIcon name={item.name} mime={item.mime} size={Math.min(height * icon * 1.6, 84)} glow={height > 110} />
        </View>
      )}
      {face && height >= 80 && (
        <View style={{ position: 'absolute', right: 6, bottom: 6 }} pointerEvents="none"><FileIcon name={item.name} mime={item.mime} size={22} glow={false} /></View>
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
