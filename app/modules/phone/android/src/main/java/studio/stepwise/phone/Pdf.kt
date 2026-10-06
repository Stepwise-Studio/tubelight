package studio.stepwise.phone

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File

/**
 * PDFs drawn by Android itself (PdfRenderer), page by page into the cache as JPEGs the app shows: the Vault's PDF
 * viewer, with no web view and no extra library. One document stays open while it's being read.
 */
object Pdf {
  private var openPath: String? = null
  private var fd: ParcelFileDescriptor? = null
  private var renderer: PdfRenderer? = null

  @Synchronized
  private fun open(path: String): PdfRenderer {
    if (openPath == path) renderer?.let { return it }
    renderer?.close(); fd?.close()
    val file = File(Uri.parse(path).path ?: path)
    val f = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    fd = f
    openPath = path
    return PdfRenderer(f).also { renderer = it }
  }

  /** Page count and every page's size in points. */
  @Synchronized
  fun info(path: String): Map<String, Any> {
    val r = open(path)
    val sizes = (0 until r.pageCount).map { i -> r.openPage(i).use { p -> listOf(p.width, p.height) } }
    return mapOf("pages" to r.pageCount, "sizes" to sizes)
  }

  /** One page at `width` px, on white; cached, so scrolling back is instant. */
  @Synchronized
  fun render(context: Context, path: String, page: Int, width: Int): Map<String, Any> {
    val dir = File(context.cacheDir, "pdf").apply { mkdirs() }
    val out = File(dir, "${path.hashCode().toUInt()}-${File(path).length()}-$page-$width.jpg")
    val r = open(path)
    return r.openPage(page).use { p ->
      val height = (p.height * (width.toFloat() / p.width)).toInt().coerceAtLeast(1)
      if (!out.exists()) {
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bmp.eraseColor(Color.WHITE)
        p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
        out.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 92, it) }
        bmp.recycle()
      }
      mapOf("uri" to Uri.fromFile(out).toString(), "width" to width, "height" to height)
    }
  }

  /**
   * Every match of `query` (Android 15+ reads the text layer itself): page, the match's boxes in page points, and a
   * line of text around it. Capped at `limit` matches.
   */
  @Synchronized
  fun search(path: String, query: String, limit: Int): List<Map<String, Any>> {
    if (android.os.Build.VERSION.SDK_INT < 35) throw UnsupportedOperationException("Search needs Android 15 or later.")
    val r = open(path)
    val out = ArrayList<Map<String, Any>>()
    for (i in 0 until r.pageCount) {
      r.openPage(i).use { p ->
        val found = p.searchText(query)
        if (found.isEmpty()) return@use
        val text = p.textContents.joinToString("") { it.text }
        for (m in found) {
          if (out.size >= limit) return out
          val at = m.textStartIndex
          val from = (at - 40).coerceAtLeast(0)
          val to = (at + query.length + 60).coerceAtMost(text.length)
          val line = if (at in 0..text.length) text.substring(from, to).replace(Regex("\\s+"), " ").trim() else ""
          out.add(mapOf(
            "page" to i,
            "rects" to m.bounds.map { b -> listOf(b.left, b.top, b.right, b.bottom) },
            "text" to (if (from > 0) "…" else "") + line,
          ))
        }
      }
    }
    return out
  }

  @Synchronized
  fun close() {
    renderer?.close(); fd?.close()
    renderer = null; fd = null; openPath = null
  }
}

/** A file another app hands over (Open with Tubelight): copied into the cache, with its real name, size and type. */
object Opened {
  fun take(context: android.content.Context, uri: String): Map<String, Any> {
    val u = Uri.parse(uri)
    val cr = context.contentResolver
    var name = u.lastPathSegment?.substringAfterLast('/') ?: "file"
    if (u.scheme == "content") {
      cr.query(u, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
      }
    }
    val dir = File(context.cacheDir, "opened").apply { mkdirs() }
    val out = File(dir, "${System.currentTimeMillis()}-${name.replace(Regex("[^\\w.\\- ()]"), "_")}")
    (cr.openInputStream(u) ?: throw IllegalStateException("Can't read that file")).use { input -> out.outputStream().use { input.copyTo(it) } }
    val mime = cr.getType(u) ?: android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: ""
    return mapOf("uri" to Uri.fromFile(out).toString(), "name" to name, "size" to out.length(), "mime" to mime)
  }
}
