// Scans the QR code Tubelight for desktop shows (tubelight://link?r=…) and hands it to the link screen. The phone's own
// camera app opens the same link, so this is only the in-app way in.
import { CameraView, useCameraPermissions } from 'expo-camera'
import { router } from 'expo-router'
import { useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Cancel01Icon } from '@hugeicons/core-free-icons'

import { Button, IconButton, Text, haptic } from '@/ui'

function linkRequest(data: string): string | null {
  const m = /^tubelight:\/\/link\?r=([\w-]{8,64})$/.exec(data.trim())
  return m ? m[1] : null
}

export default function ScanScreen() {
  const insets = useSafeAreaInsets()
  const [perm, ask] = useCameraPermissions()
  const done = useRef(false)

  const close = (
    <View style={{ position: 'absolute', top: insets.top + 8, left: 12 }}>
      <IconButton icon={Cancel01Icon} round accessibilityLabel="Close" onPress={() => router.back()} />
    </View>
  )
  if (!perm?.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: '#09090b', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
        <Text variant="headline" align="center" style={{ color: '#f4f4f5' }}>Scan your computer’s code</Text>
        <Text variant="body" align="center" style={{ color: '#a1a1aa' }}>
          {perm && !perm.canAskAgain ? 'Camera access is off for Tubelight. Turn it on in Android settings, or point your phone’s camera app at the code instead.'
            : 'Tubelight needs the camera to read the QR code on your computer. It only looks for that code.'}
        </Text>
        {(!perm || perm.canAskAgain) && <Button label="Allow camera" onPress={ask} />}
        {close}
      </View>
    )
  }
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          const r = linkRequest(data)
          if (!r || done.current) return
          done.current = true
          haptic.success()
          router.replace({ pathname: '/link', params: { r } })
        }}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', gap: 24 }]}>
        <View style={{ width: 240, height: 240, borderRadius: 28, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' }} />
        <Text variant="bodyMedium" align="center" style={{ color: '#fff', paddingHorizontal: 40 }}>
          Point at the code in Tubelight on your computer
        </Text>
      </View>
      {close}
    </View>
  )
}
