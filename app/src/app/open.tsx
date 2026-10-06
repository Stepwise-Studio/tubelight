// A file another app opened with Tubelight: read it in the app's own viewer, keep it in the Vault, or share it.
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { MoreHorizontalIcon, Share08Icon, VaultIcon } from '@hugeicons/core-free-icons'

import { shareItem } from '@/components/vault/actions'
import { ViewerScreen } from '@/components/vault/viewer-screen'
import { Phone } from '@/lib/phone'
import { uploadFiles, type Viewable } from '@/lib/vault'
import { useTheme } from '@/theme'
import { IconButton, Text, showMenu, toast } from '@/ui'

export default function OpenedFile() {
  const { uri } = useLocalSearchParams<{ uri: string }>()
  const { c } = useTheme()
  const [file, setFile] = useState<{ uri: string; name: string; size: number; mime: string } | null>(null)
  const [error, setError] = useState<string | null>(Phone?.openFile ? null : 'Update Tubelight to open files from other apps.')
  useEffect(() => {
    if (!Phone?.openFile || !uri) return
    Phone.openFile(uri).then(setFile, (e) => setError((e as Error).message))
  }, [uri])
  if (error) return <View style={{ flex: 1, backgroundColor: c.canvas, alignItems: 'center', justifyContent: 'center', padding: 32 }}><Text color="ink3" align="center">{error}</Text></View>
  if (!file) return <View style={{ flex: 1, backgroundColor: c.canvas }} />
  const item: Viewable = { id: file.uri, name: file.name, mime: file.mime, size: file.size, meta: {}, src: file.uri, preview: `upload:${file.uri}` }
  return (
    <ViewerScreen item={item} actions={(ink) => (
      <IconButton icon={MoreHorizontalIcon} color={ink} accessibilityLabel="More: save to Vault, share" onPress={() => showMenu({
        title: file.name,
        items: [
          { label: 'Save to Vault', icon: VaultIcon, onPress: async () => {
            const r = await uploadFiles([{ uri: file.uri, name: file.name, mime: file.mime, size: file.size }], '')
            toast(r.done ? { title: 'Saved to your vault', body: file.name, tone: 'success' } : { title: 'Unable to save it', tone: 'error' })
          } },
          { label: 'Share or open in…', icon: Share08Icon, onPress: () => shareItem(item) },
        ],
      })} />
    )} />
  )
}
