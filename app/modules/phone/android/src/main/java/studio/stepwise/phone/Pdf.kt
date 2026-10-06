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

  @Synchronized
  fun close() {
    renderer?.close(); fd?.close()
    renderer = null; fd = null; openPath = null
  }
}
