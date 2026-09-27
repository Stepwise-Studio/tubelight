import { NewProject } from '@/components/new-project-sheet'
import { NewTeammate } from '@/components/new-teammate-sheet'
import { SheetScreen, useOpenSheet } from '@/components/sheet-screen'

/** Mount once above the navigator (root layout): shows the sheet `openSheet()` asked for. */
export function SheetsHost() {
  const open = useOpenSheet()
  if (!open) return null
  return <SheetScreen key={open}>{open === 'teammate' ? <NewTeammate /> : <NewProject />}</SheetScreen>
}
