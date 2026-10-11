package studio.stepwise.phone

import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.File

/**
 * The phone's own files for the Vault's "On this phone": folders and recent documents. Reading other apps' files
 * needs "All files access" (the user allows it in settings), the way file managers do.
 */
object Files {
  fun allowed(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

  private fun mimeOf(name: String) = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: ""

  private fun row(f: File): Map<String, Any> = mapOf(
    "name" to f.name, "path" to f.absolutePath, "dir" to f.isDirectory, "size" to (if (f.isDirectory) (f.list()?.size ?: 0).toLong() else f.length()),
    "modified" to f.lastModified().toDouble(), "mime" to (if (f.isDirectory) "" else mimeOf(f.name)),
  )

  /** A folder's contents (hidden files left out); "" = the phone's shared storage. */
  fun list(path: String): Map<String, Any> {
    val root = Environment.getExternalStorageDirectory()
    val dir = if (path.isEmpty()) root else File(path)
    if (!dir.canonicalPath.startsWith(root.canonicalPath)) throw IllegalArgumentException("Outside the phone's storage")
    val kids = (dir.listFiles() ?: emptyArray()).filter { !it.name.startsWith(".") }
    return mapOf("path" to dir.absolutePath, "root" to root.absolutePath, "items" to kids.map { row(it) })
  }

  private val DOCS = listOf("pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "md", "txt", "epub", "zip")

  /** The newest documents anywhere on the phone (MediaStore), by kind: "docs" or one extension. */
  fun recent(context: Context, kind: String, limit: Int): List<Map<String, Any>> {
    val exts = if (kind == "docs") DOCS else listOf(kind)
    val where = exts.joinToString(" OR ") { "${MediaStore.Files.FileColumns.DISPLAY_NAME} LIKE ?" }
    val args = exts.map { "%.$it" }.toTypedArray()
    val cols = arrayOf(MediaStore.Files.FileColumns.DATA, MediaStore.Files.FileColumns.DISPLAY_NAME, MediaStore.Files.FileColumns.SIZE, MediaStore.Files.FileColumns.DATE_MODIFIED)
    val out = mutableListOf<Map<String, Any>>()
    context.contentResolver.query(MediaStore.Files.getContentUri("external"), cols, where, args, "${MediaStore.Files.FileColumns.DATE_MODIFIED} DESC")?.use { c ->
      while (c.moveToNext() && out.size < limit) {
        val path = c.getString(0) ?: continue
        if (path.contains("/.") || path.contains("/Android/")) continue
        val name = c.getString(1) ?: path.substringAfterLast('/')
        out += mapOf("name" to name, "path" to path, "dir" to false, "size" to c.getLong(2), "modified" to c.getLong(3) * 1000.0, "mime" to mimeOf(name))
      }
    }
    return out
  }

  private fun inside(f: File): File {
    val root = Environment.getExternalStorageDirectory().canonicalPath
    if (!f.canonicalPath.startsWith(root)) throw IllegalArgumentException("Outside the phone's storage")
    return f
  }

  /** Tells Android's media index what changed, so galleries and recent-file lists don't show stale files. */
  private fun rescan(context: Context, paths: List<String>) {
    MediaScannerConnection.scanFile(context, paths.toTypedArray(), null, null)
  }

  private fun clean(name: String): String {
    val n = name.trim().replace(Regex("[/\\u0000]"), "_")
    if (n.isEmpty() || n == "." || n == "..") throw IllegalArgumentException("Give it a name.")
    return n
  }

  /** Renames a file or folder; returns its new row. */
  fun rename(context: Context, path: String, name: String): Map<String, Any> {
    val f = inside(File(path))
    val to = File(f.parentFile, clean(name))
    if (to.exists()) throw IllegalStateException("Something called ${to.name} is already there.")
    if (!f.renameTo(to)) throw IllegalStateException("Android didn't allow renaming ${f.name}.")
    rescan(context, listOf(f.absolutePath, to.absolutePath))
    return row(to)
  }

  /** Deletes files and folders (with everything inside) for good. */
  fun delete(context: Context, paths: List<String>): Int {
    var n = 0
    for (p in paths) {
      val f = inside(File(p))
      if (f.isDirectory) f.deleteRecursively() else f.delete()
      if (!f.exists()) n++
    }
    rescan(context, paths)
    return n
  }

  /** Moves files and folders into a folder (a copy and delete when renaming can't, e.g. to an SD card). */
  fun move(context: Context, paths: List<String>, dir: String): Int {
    val dest = inside(File(dir))
    if (!dest.isDirectory) throw IllegalArgumentException("That folder is gone.")
    var n = 0
    val changed = ArrayList<String>()
    for (p in paths) {
      val f = inside(File(p))
      if (f.parentFile?.canonicalPath == dest.canonicalPath) continue
      if (f.isDirectory && dest.canonicalPath.startsWith(f.canonicalPath + "/")) throw IllegalArgumentException("A folder can't go inside itself.")
      var to = File(dest, f.name)
      var i = 2
      while (to.exists()) { to = File(dest, if (f.isDirectory || !f.name.contains('.')) "${f.name} ($i)" else "${f.nameWithoutExtension} ($i).${f.extension}"); i++ }
      if (!f.renameTo(to)) { f.copyRecursively(to); f.deleteRecursively() }
      changed += listOf(f.absolutePath, to.absolutePath)
      n++
    }
    rescan(context, changed)
    return n
  }

  /** A new folder; returns its row. */
  fun mkdir(parent: String, name: String): Map<String, Any> {
    val d = File(inside(File(parent.ifEmpty { Environment.getExternalStorageDirectory().absolutePath })), clean(name))
    if (d.exists()) throw IllegalStateException("${d.name} is already there.")
    if (!d.mkdirs()) throw IllegalStateException("Android didn't allow making ${d.name}.")
    return row(d)
  }
}
