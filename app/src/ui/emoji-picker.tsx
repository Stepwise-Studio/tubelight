import { useMemo, useState, useSyncExternalStore } from 'react'
import { FlatList, Keyboard, View, useWindowDimensions } from 'react-native'

import { useTheme } from '@/theme'

import { Press } from './press'
import { Sheet } from './sheet'
import { Text } from './text'
import { SearchField } from './text-field'

type Pick = (emoji: string) => void
let state: { open: boolean; onPick?: Pick } = { open: false }
const listeners = new Set<() => void>()
const set = (s: typeof state) => { state = s; listeners.forEach((l) => l()) }

/** Every emoji, searchable by name (like WhatsApp's "more" reactions). Needs <EmojiPickerHost/>. `after` lets a sheet
 * that's closing finish first, so two sheets never animate at once. */
export function showEmojiPicker(onPick: Pick, after = 0) {
  emojis() // parse the list now, before the sheet animates
  setTimeout(() => set({ open: true, onPick }), after)
}

/** Parse the emoji list ahead of time (e.g. when a menu that offers "more" opens), off the open's critical path. */
export const warmEmojis = () => setTimeout(emojis, 50)

const COLS = 8
let all: { e: string; name: string }[] | null = null
// Loaded on first open, not at startup: it's the full Unicode list (~1.9k emoji).
const emojis = () => (all ??= Object.entries(require('unicode-emoji-json/data-by-emoji.json') as Record<string, { name: string; group: string }>)
  .map(([e, d]) => ({ e, name: `${d.name} ${d.group}`.toLowerCase() })))

export function EmojiPickerHost() {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state, () => state)
  const close = () => set({ ...state, open: false })
  return (
    <Sheet open={s.open} onClose={() => { Keyboard.dismiss(); close() }} title="React with">
      {s.open && <Grid onPick={(e) => { Keyboard.dismiss(); close(); s.onPick?.(e) }} />}
    </Sheet>
  )
}

function Grid({ onPick }: { onPick: Pick }) {
  const { c } = useTheme()
  const { width, height } = useWindowDimensions()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const list = useMemo(() => (q ? emojis().filter((x) => x.name.includes(q)) : emojis()), [q])
  const cell = Math.floor((width - 16 - 32) / COLS)
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 10 }}>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search emoji" />
      <FlatList
        data={list}
        keyExtractor={(x) => x.e}
        numColumns={COLS}
        // Fits above the keyboard with the title and search field still on screen.
        style={{ height: Math.min(340, Math.round(height * 0.3)) }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={40}
        maxToRenderPerBatch={40}
        windowSize={5}
        getItemLayout={(_, row) => ({ length: cell, offset: cell * row, index: row })}  // rows, with numColumns
        ListEmptyComponent={<Text variant="footnote" color="ink3" style={{ textAlign: 'center', paddingTop: 24 }}>No emoji called “{query.trim()}”.</Text>}
        renderItem={({ item }) => (
          <Press radius={10} onPress={() => onPick(item.e)} accessibilityLabel={item.name} style={{ width: cell, height: cell, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' }} wash={c.panel2}>
            <Text style={{ fontSize: 26, lineHeight: 32 }}>{item.e}</Text>
          </Press>
        )}
      />
    </View>
  )
}
