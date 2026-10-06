// Files other apps open with Tubelight (a PDF from Files, a photo, a document) arrive as content:// links: they go to
// the viewer instead of the router.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (path.startsWith('content://') || path.startsWith('file://')) return `/open?uri=${encodeURIComponent(path)}`
  // Google sign-in's return: the sign-in tab reads it; the router stays where it is.
  if (/^(tubelight:\/\/|\/)auth\b/.test(path)) return '/'
  return path
}
