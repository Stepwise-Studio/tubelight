// Full-screen view of a chat image, with Save to photos. Images are signed Supabase URLs; saving downloads to the
// cache, then adds it to the gallery (Pictures) with expo-media-library.
import { File, Paths } from 'expo-file-system'
import { Image } from 'expo-image'
import { Asset, requestPermissionsAsync } from 'expo-media-library'
import { useState } from 'react'
import { Modal, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Cancel01Icon, Download04Icon } from '@hugeicons/core-free-icons'

import { Button, IconButton, haptic, toast } from '@/ui'

export async function saveImage(url: string, name: string) {
  try {
    const { granted } = await requestPermissionsAsync(true, ['photo'])
    if (!granted) { toast({ title: 'Allow Tubelight to save photos', body: 'Turn it on in Settings, then try again.', tone: 'error' }); return }
    const file = new File(Paths.cache, `${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`)
    await File.downloadFileAsync(url, file)
    await Asset.create(file.uri)
    file.delete()
    haptic.success()
    toast({ title: 'Saved to your photos', tone: 'success' })
  } catch (e) {
    toast({ title: 'Unable to save the image', body: (e as Error).message, tone: 'error' })
  }
}

export function ImageViewer({ url, name, onClose }: { url: string | null; name: string; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const [saving, setSaving] = useState(false)
  return (
    <Modal visible={!!url} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {url && <Image source={url} style={{ flex: 1 }} contentFit="contain" accessibilityLabel={name} />}
        <View style={{ position: 'absolute', top: insets.top + 8, right: 12 }}>
          <IconButton icon={Cancel01Icon} variant="soft" round accessibilityLabel="Close" onPress={onClose} />
        </View>
        <View style={{ position: 'absolute', left: 20, right: 20, bottom: insets.bottom + 20 }}>
          <Button label="Save to photos" icon={Download04Icon} loading={saving}
            onPress={async () => { if (!url) return; setSaving(true); await saveImage(url, name); setSaving(false) }} />
        </View>
      </View>
    </Modal>
  )
}
