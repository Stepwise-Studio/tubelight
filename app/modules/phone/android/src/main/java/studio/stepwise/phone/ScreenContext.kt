package studio.stepwise.phone

import android.app.assist.AssistStructure
import android.content.Context
import android.graphics.Bitmap
import android.text.InputType
import android.util.Base64
import java.io.ByteArrayOutputStream

/** What was on screen when the assistant was summoned: AssistSession (app) fills it, the panel takes it once. */
object ScreenContext {
  @Volatile private var app: String? = null
  @Volatile private var text: String? = null
  @Volatile private var image: String? = null
  @Volatile private var at = 0L

  /** The app's name and the text on its screen, password fields left out. */
  fun fromStructure(context: Context, s: AssistStructure) {
    val pkg = s.activityComponent?.packageName
    app = pkg?.let {
      try { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(it, 0)).toString() } catch (_: Exception) { it }
    }
    val lines = LinkedHashSet<String>()
    fun walk(n: AssistStructure.ViewNode) {
      if (lines.sumOf { it.length } > 4000) return
      val variation = n.inputType and InputType.TYPE_MASK_VARIATION
      val secret = n.inputType != 0 && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
        variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
      if (!secret) (n.text ?: n.contentDescription)?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { lines.add(it) }
      for (i in 0 until n.childCount) walk(n.getChildAt(i))
    }
    for (i in 0 until s.windowNodeCount) walk(s.getWindowNodeAt(i).rootViewNode)
    text = lines.joinToString("\n").take(4000)
    at = System.currentTimeMillis()
  }

  /** The screenshot, small enough for a voice model (1080 px wide, JPEG). */
  fun fromBitmap(b: Bitmap?) {
    if (b == null) return
    val scaled = if (b.width > 1080) Bitmap.createScaledBitmap(b, 1080, b.height * 1080 / b.width, true) else b
    val out = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.JPEG, 70, out)
    image = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    at = System.currentTimeMillis()
  }

  /** Once, and only if it's from just now (an old screen would mislead). */
  fun take(): Map<String, Any?>? {
    val fresh = System.currentTimeMillis() - at < 20_000 && (text != null || image != null)
    val out = if (fresh) mapOf("app" to app, "text" to text, "image" to image) else null
    app = null; text = null; image = null; at = 0
    return out
  }
}
