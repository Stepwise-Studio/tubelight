// Linking a computer (agent-service computers.py): opened by the in-app scanner or straight from the phone's camera
// (tubelight://link?r=…). The phone claims the code for this account; the computer then shows the account's email and
// the person confirms there too, so a code photographed off someone's screen links nothing.
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LaptopIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { ApiError, api } from '@/lib/api'
import { useTheme } from '@/theme'
import { Button, Icon, Skeleton, SuccessCheck, Text, ThinkingIndicator, haptic } from '@/ui'

interface Req { name: string; os: string; state: 'waiting' | 'scanned' | 'linked' | 'taken'; id: string | null }

export default function LinkScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { r } = useLocalSearchParams<{ r: string }>()
  const [req, setReq] = useState<Req | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => api<Req>(`/computers/requests/${encodeURIComponent(r ?? '')}`).then(
      (q) => { if (alive) { setReq(q); if (q.state === 'linked') haptic.success() } },
      (e: Error) => { if (alive) setError(e instanceof ApiError && e.status === 404 ? 'This code expired. The computer shows a new one: scan that.' : e.message) })
    load()
    const t = setInterval(() => { if (req?.state === 'scanned') load() }, 2000)  // waiting for the computer's OK
    return () => { alive = false; clearInterval(t) }
  }, [r, req?.state])

  const link = async () => {
    setBusy(true)
    try {
      setReq(await api<Req>(`/computers/requests/${encodeURIComponent(r ?? '')}`, { method: 'POST' }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const name = req?.name ?? 'this computer'
  const body = error ? (
    <>
      <Text variant="headline" align="center">Couldn’t link it</Text>
      <Text variant="body" color="ink2" align="center">{error}</Text>
      <Button label="Scan again" onPress={() => router.replace('/scan')} />
    </>
  ) : !req ? (
    <><Skeleton width="60%" height={22} /><Skeleton width="80%" /></>
  ) : req.state === 'taken' ? (
    <>
      <Text variant="headline" align="center">Already being linked</Text>
      <Text variant="body" color="ink2" align="center">Another account scanned this code first. On the computer, choose “That’s not me” to get a fresh one.</Text>
    </>
  ) : req.state === 'waiting' ? (
    <>
      <Text variant="headline" align="center">Link {name}?</Text>
      <Text variant="body" color="ink2" align="center">
        Teammates will be able to read the folders you share on it, and change files or run commands there after you approve each step here.
      </Text>
      <Button label={`Link ${name}`} loading={busy} onPress={link} fullWidth />
      <Button label="Cancel" variant="ghost" onPress={() => router.back()} fullWidth />
    </>
  ) : req.state === 'scanned' ? (
    <>
      <Text variant="headline" align="center">Now confirm on {name}</Text>
      <Text variant="body" color="ink2" align="center">Tubelight on the computer is asking whether to link to your account. Choose Link there.</Text>
      <ThinkingIndicator state="waiting" label="Waiting for the computer" />
    </>
  ) : (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><SuccessCheck size={22} /><Text variant="headline">{name} is linked</Text></View>
      <Text variant="body" color="ink2" align="center">Share a folder in Tubelight on the computer (the + next to Shared folders), then ask a teammate to work in it.</Text>
      <Button label="Done" onPress={() => router.replace('/computers')} fullWidth />
    </>
  )

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Link a computer" />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, paddingBottom: insets.bottom + 48, gap: 14 }}>
        <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
          <Icon icon={LaptopIcon} size={30} color="ink2" />
        </View>
        {body}
      </View>
    </View>
  )
}
