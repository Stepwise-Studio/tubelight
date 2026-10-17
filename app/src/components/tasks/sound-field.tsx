// An alarm's sound, picked the way the phone does it: a rounded field showing the current one; it opens a list with
// your own sounds first (files you picked for any alarm, and "Choose a file…" for a new one from the phone's storage),
// then the phone's alarm sounds and ringtones. Tapping one plays a few seconds of it on the alarm stream.
import { useEffect, useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import { Add01Icon, ArrowRight01Icon, MusicNote01Icon } from '@hugeicons/core-free-icons'

import { useAlarms } from '@/lib/clock'
import { Phone } from '@/lib/phone'
import { useTheme } from '@/theme'
import { Icon, Sheet, Squircle, Text, haptic } from '@/ui'

type Tone = { title: string; uri: string; kind: 'alarm' | 'ringtone' }
const tidy = (t: string) => t.replace(/_/g, ' ')

export function SoundField({ sound, name, onChange }: { sound: string; name: string; onChange: (sound: string, name: string) => void }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const [tones, setTones] = useState<Tone[]>([])
  const alarms = useAlarms().rows ?? []
  useEffect(() => {
    Phone?.alarmTones?.().then(setTones, () => {})
    return () => Phone?.stopTone?.()
  }, [])
  // Files picked for any alarm (and this one's, even if just picked).
  const mine = new Map<string, string>()
  for (const a of alarms) if (a.sound?.startsWith('content://') && !tones.some((t) => t.uri === a.sound)) mine.set(a.sound, a.sound_name || 'Your sound')
  if (sound && !tones.some((t) => t.uri === sound)) mine.set(sound, name || 'Your sound')
  const shown = sound ? (tones.find((t) => t.uri === sound)?.title ?? name) : 'Phone’s alarm sound'
  const pick = (uri: string, title: string) => { haptic.tap(); onChange(uri, title); Phone?.previewTone?.(uri) }
  const choose = async () => {
    Phone?.stopTone?.()
    const f = await Phone?.pickSoundFile?.()
    if (f) pick(f.uri, f.title)
  }
  const close = () => { Phone?.stopTone?.(); setOpen(false) }
  // One flat, virtualised list (only what's on screen is drawn), light rows with a plain radio: it opens at once.
  type Item = { key: string; group?: string; uri?: string; title?: string; sub?: string; file?: boolean }
  const items: Item[] = [
    { key: 'g:mine', group: 'Your sounds' },
    ...[...mine].map(([uri, title]) => ({ key: uri, uri, title })),
    { key: 'file', file: true },
    { key: 'g:alarm', group: 'Alarm sounds' },
    { key: 'default', uri: '', title: 'Phone’s alarm sound', sub: 'What your clock app rings with' },
    ...tones.filter((t) => t.kind === 'alarm').map((t) => ({ key: t.uri, uri: t.uri, title: t.title })),
    ...(tones.some((t) => t.kind === 'ringtone') ? [{ key: 'g:ring', group: 'Ringtones' }] : []),
    ...tones.filter((t) => t.kind === 'ringtone').map((t) => ({ key: t.uri, uri: t.uri, title: t.title })),
  ]
  const draw = ({ item }: { item: Item }) => {
    if (item.group) return <Group title={item.group} />
    if (item.file) return (
      <Pressable onPress={choose} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 52, paddingHorizontal: 12 }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={Add01Icon} size={15} color="ink2" />
        </View>
        <Text variant="bodyMedium" color="tube">Choose a file…</Text>
      </Pressable>
    )
    const on = item.uri === sound
    return (
      <Pressable onPress={() => pick(item.uri!, item.title!)} android_ripple={{ color: c.wash }} accessibilityRole="radio" accessibilityState={{ checked: on }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="body" numberOfLines={1}>{tidy(item.title!)}</Text>
          {!!item.sub && <Text variant="footnote" color="ink3">{item.sub}</Text>}
        </View>
        <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: on ? 0 : 1.5, borderColor: c.edge, backgroundColor: on ? c.ink : undefined, alignItems: 'center', justifyContent: 'center' }}>
          {on && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.canvas }} />}
        </View>
      </Pressable>
    )
  }

  return (
    <>
      <Pressable onPress={() => { haptic.tap(); setOpen(true) }} accessibilityRole="button" accessibilityLabel={`Sound, ${tidy(shown)}. Change`}>
        <Squircle style={{ borderRadius: 26, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, height: 68 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon icon={MusicNote01Icon} size={19} color="tube" />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="footnote" color="ink3">Sound</Text>
            <Text variant="bodyMedium" numberOfLines={1}>{tidy(shown)}</Text>
          </View>
          <Icon icon={ArrowRight01Icon} size={18} color="ink3" />
        </Squircle>
      </Pressable>
      <Sheet open={open} onClose={close} title="Sound">
        <FlatList data={items} renderItem={draw} keyExtractor={(i) => i.key} style={{ maxHeight: 520 }}
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 16 }} initialNumToRender={12} windowSize={5} />
      </Sheet>
    </>
  )
}

function Group({ title }: { title: string }) {
  return <Text variant="overline" color="ink3" style={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 4 }}>{title}</Text>
}
