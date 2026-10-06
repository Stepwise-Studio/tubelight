// A file from a chat (one a teammate made, or one you sent), opened in the app's own viewer: read it here, download
// it, keep it in the Vault or share it.
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, View } from 'react-native'
import { Download03Icon, MoreHorizontalIcon, Share08Icon, VaultIcon } from '@hugeicons/core-free-icons'

import { shareItem } from '@/components/vault/actions'
import { ViewerScreen } from '@/components/vault/viewer-screen'
import { supabase } from '@/lib/supabase'
import { saveAttachment, type Viewable } from '@/lib/vault'
import { useTheme } from '@/theme'
import { IconButton, Text, haptic, showMenu, toast } from '@/ui'

export default function ChatFile() {
  const { path, name, mime, size, pages } = useLocalSearchParams<{ path: string; name: string; mime?: string; size?: string; pages?: string }>()
  const { c } = useTheme()
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    supabase.storage.from('attachments').createSignedUrl(path, 60 * 60 * 6).then(({ data, error: e }) => {
      if (data?.signedUrl) setSrc(data.signedUrl)
      else setError(e?.message ?? 'That file is gone.')
    })
  }, [path])
  if (error) return <View style={{ flex: 1, backgroundColor: c.canvas, alignItems: 'center', justifyContent: 'center', padding: 32 }}><Text color="ink3" align="center">{error}</Text></View>
  if (!src) return <View style={{ flex: 1, backgroundColor: c.canvas }} />
  const item: Viewable = {
    id: path, name, mime: mime ?? '', size: Number(size) || 0, meta: pages ? { pages: Number(pages) } : {}, src,
    preview: `/attachments/preview?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
  }
  const download = async () => {
    haptic.tap()
    const { data } = await supabase.storage.from('attachments').createSignedUrl(path, 60 * 60, { download: name })
    if (data?.signedUrl) Linking.openURL(data.signedUrl)
  }
  return (
    <ViewerScreen item={item} actions={(ink) => (
      <IconButton icon={MoreHorizontalIcon} color={ink} accessibilityLabel="More: save to Vault, share, download" onPress={() => showMenu({
        title: name,
        items: [
          { label: 'Save to Vault', icon: VaultIcon, onPress: () => saveAttachment({ path, name }).then(() => toast({ title: 'Saved to your vault', body: name, tone: 'success' }),
            (e) => toast({ title: 'Unable to save it', body: (e as Error).message, tone: 'error' })) },
          { label: 'Share', icon: Share08Icon, onPress: () => shareItem(item) },
          { label: 'Download', icon: Download03Icon, onPress: download },
        ],
      })} />
    )} />
  )
}
