// Files that aren't in the vault (Google Drive, the phone's own) open in the vault's viewer at /vault/view.
import { router } from 'expo-router'

import type { Viewable } from '@/lib/vault'
import type { MenuItem } from '@/ui'

export let opened: { item: Viewable; menu: () => MenuItem[] } | null = null

/** Opens a Drive or phone file in the viewer, with what its ⋯ menu offers. */
export function openOutside(item: Viewable, menu: () => MenuItem[]) {
  opened = { item, menu }
  router.push('/vault/view')
}
