// An alarm's sound, picked the way the phone does it: a rounded field showing the current one; it opens a list with
// your own sounds first (files you picked for any alarm, and "Choose a file…" for a new one from the phone's storage),
// then the phone's alarm sounds and ringtones. Tapping one plays a few seconds of it on the alarm stream.
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Add01Icon, ArrowRight01Icon, MusicNote01Icon } from '@hugeicons/core-free-icons'

import { useAlarms } from '@/lib/clock'
import { Phone } from '@/lib/phone'
import { useTheme } from '@/theme'
import { Icon, RadioRow, Sheet, Squircle, Text, haptic } from '@/ui'

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
  const row = (uri: string, title: string, sub?: string) => (
    <RadioRow key={uri || 'default'} title={tidy(title)} subtitle={sub} checked={uri === sound} onPress={() => pick(uri, title)} />
  )

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
        <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 16 }}>
          <Group title="Your sounds" />
          {[...mine].map(([uri, title]) => row(uri, title))}
          <Pressable onPress={choose} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 52, paddingHorizontal: 12 }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
              <Icon icon={Add01Icon} size={15} color="ink2" />
            </View>
            <Text variant="bodyMedium" color="tube">Choose a file…</Text>
          </Pressable>
          <Group title="Alarm sounds" />
          {row('', 'Phone’s alarm sound', 'What your clock app rings with')}
          {tones.filter((t) => t.kind === 'alarm').map((t) => row(t.uri, t.title))}
          {tones.some((t) => t.kind === 'ringtone') && <Group title="Ringtones" />}
          {tones.filter((t) => t.kind === 'ringtone').map((t) => row(t.uri, t.title))}
        </ScrollView>
      </Sheet>
    </>
  )
}

function Group({ title }: { title: string }) {
  return <Text variant="overline" color="ink3" style={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 4 }}>{title}</Text>
}
