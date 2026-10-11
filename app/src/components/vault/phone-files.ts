// The phone's own files for the Vault ("On this phone"): access, opening one in the viewer.
import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { Share08Icon, VaultIcon } from '@hugeicons/core-free-icons'

import { Phone } from '@/lib/phone'
import { uploadFiles, type Viewable } from '@/lib/vault'
import { haptic, toast } from '@/ui'

import type { PhoneFile } from '../../../modules/phone'
import { shareItem } from './actions'
import { openOutside } from './outside'

export type { PhoneFile }

export const PLACES = ['Download', 'Documents', 'DCIM', 'Pictures', 'Movies', 'Music']

export function usePhoneAccess() {
  const [allowed, setAllowed] = useState(() => Phone?.filesAllowed?.() ?? false)
  useEffect(() => {
    const s = AppState.addEventListener('change', (st) => { if (st === 'active') setAllowed(Phone?.filesAllowed?.() ?? false) })
    return () => s.remove()
  }, [])
  return allowed
}

export function openPhoneFile(f: PhoneFile) {
  haptic.tap()
  const src = `file://${f.path}`
  const v: Viewable = { id: f.path, name: f.name, mime: f.mime, size: f.size, meta: {}, src, preview: `upload:${src}` }
  openOutside(v, () => [
    { label: 'Save to Vault', icon: VaultIcon, onPress: async () => {
      const r = await uploadFiles([{ uri: src, name: f.name, mime: f.mime, size: f.size }], '')
      toast(r.done ? { title: 'Saved to your vault', body: f.name, tone: 'success' } : { title: 'Unable to save it', tone: 'error' })
    } },
    { label: 'Share or open in…', icon: Share08Icon, onPress: () => shareItem(v) },
  ])
}

