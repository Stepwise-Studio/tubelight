package studio.stepwise.phone

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import expo.modules.kotlin.exception.CodedException

/**
 * Using apps on the phone, the way runner/tubelight_driver.py does on Linux: the app in front (never Tubelight's own
 * windows, so it works with the assistant open over it) read through Android's accessibility service as a snapshot of
 * elements, "[e3] button “Send” (click)", and acted on by id: click, type, scroll, plus back/home/recents. An action on
 * an element that's gone answers "stale" with the screen as it is now; after acting it waits for the app to settle.
 * Off until the user turns on Tubelight under Settings → Accessibility (sideloaded apps first need "Allow restricted
 * settings" in the app's info page).
 */
class AppsService : AccessibilityService() {
  override fun onServiceConnected() { Apps.service = this }
  override fun onAccessibilityEvent(e: AccessibilityEvent) { Apps.lastEvent = System.currentTimeMillis() }
  override fun onInterrupt() {}
  override fun onDestroy() { if (Apps.service === this) Apps.service = null; super.onDestroy() }
}

object Apps {
  @Volatile var service: AppsService? = null
  @Volatile var lastEvent = 0L
  private var snap = 0
  private val nodes = HashMap<String, AccessibilityNodeInfo>()
  private const val MAX = 160

  fun on(c: Context) = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
    .contains("${c.packageName}/") && service != null

  private fun svc() = service ?: throw CodedException("Turn on Tubelight under Settings → Accessibility first: Profile → Phone assistant.")

  /** The app the user sees: the top application window that isn't Tubelight's own (the assistant may sit above it). */
  private fun root(s: AppsService): AccessibilityNodeInfo {
    val mine = s.packageName
    s.windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }.sortedByDescending { it.layer }
      .firstNotNullOfOrNull { w -> w.root?.takeIf { it.packageName?.toString() != mine } }?.let { return it }
    return s.rootInActiveWindow?.takeIf { it.packageName?.toString() != mine }
      ?: s.windows.firstNotNullOfOrNull { it.root?.takeIf { r -> r.packageName?.toString() != mine } }
      ?: throw CodedException("No app is open in front.")
  }

  private fun role(n: AccessibilityNodeInfo): String {
    val cls = n.className?.toString()?.substringAfterLast('.') ?: ""
    return when {
      n.isEditable -> "text field"
      n.isCheckable && cls.contains("Switch") -> "switch"
      n.isCheckable -> "checkbox"
      cls.contains("Button") -> "button"
      cls.contains("Image") -> if (n.isClickable) "button" else "image"
      n.isScrollable -> "list"
      cls.contains("Tab") -> "tab"
      n.isClickable -> "item"
      else -> "text"
    }
  }

  /** A fresh snapshot of the app in front: id, text for the model, and the app's name. */
  @Synchronized
  fun look(c: Context): Map<String, Any> {
    val s = svc()
    val r = root(s)
    nodes.clear()
    snap++
    val lines = mutableListOf<String>()
    fun walk(n: AccessibilityNodeInfo?, depth: Int) {
      if (n == null || depth > 40 || nodes.size >= MAX) return
      if (n.isVisibleToUser) {
        // What it shows and what it's called, when they differ ("C" is Clear), plus the app's own id for it
        // ({btn_clear}): models find the right element far more reliably with all three.
        val shown = (n.text ?: n.hintText ?: "").toString().replace('\n', ' ').trim().take(80)
        val called = n.contentDescription?.toString()?.replace('\n', ' ')?.trim()?.take(60).orEmpty()
        val name = shown.ifEmpty { called }
        val aka = if (shown.isNotEmpty() && called.isNotEmpty() && !called.equals(shown, true)) " aka “$called”" else ""
        val rid = n.viewIdResourceName?.substringAfterLast('/')?.let { " {$it}" }.orEmpty()
        val acts = buildList {
          if (n.isClickable || n.isCheckable) add("click")
          if (n.isEditable) add("type")
          if (n.isScrollable) add("scroll")
        }
        if (name.isNotEmpty() || acts.isNotEmpty()) {
          val id = "e${nodes.size + 1}"
          nodes[id] = n
          val value = if (n.isEditable) " = ${n.text ?: ""}".take(80) else if (n.isCheckable) " = ${if (n.isChecked) "on" else "off"}" else ""
          lines.add("[$id] ${role(n)} “$name”$aka$rid$value${if (acts.isEmpty()) "" else " (${acts.joinToString(", ")})"}")
        }
      }
      for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
    }
    walk(r, 0)
    val pkg = r.packageName?.toString() ?: ""
    val app = try { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(pkg, 0)).toString() } catch (_: Exception) { pkg }
    return mapOf("snapshot" to "s$snap", "app" to app, "text" to "Snapshot s$snap: $app\n" + lines.joinToString("\n"))
  }

  /** Waits for the app to settle: at least 400 ms, then until it's quiet for 300 ms (2.5 s at most). */
  private fun settle() {
    val start = System.currentTimeMillis()
    Thread.sleep(400)
    while (System.currentTimeMillis() - start < 2500 && System.currentTimeMillis() - lastEvent < 300) Thread.sleep(60)
  }

  /** One action on an element of snapshot `snapshot`; the answer carries the screen afterwards. */
  fun act(c: Context, snapshot: String, element: String, action: String, value: String): Map<String, Any> {
    val did: String
    synchronized(this) {
      if (snapshot != "s$snap") return look(c) + mapOf("status" to "stale", "why" to "the screen changed since that snapshot")
      val n = nodes[element] ?: throw CodedException("No element $element in that snapshot.")
      if (!n.refresh()) return look(c) + mapOf("status" to "stale", "why" to "$element is gone")
      did = when (action.uppercase()) {
        "CLICK" -> {
          var t: AccessibilityNodeInfo? = n
          while (t != null && !t.isClickable) t = t.parent
          if (t?.performAction(AccessibilityNodeInfo.ACTION_CLICK) != true) throw CodedException("$element can't be clicked.")
          "clicked $element"
        }
        "TYPE" -> {
          n.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
          val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) }
          if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw CodedException("$element doesn't take text.")
          "typed into $element"
        }
        "SCROLL" -> {
          var t: AccessibilityNodeInfo? = n
          while (t != null && !t.isScrollable) t = t.parent
          val up = value.lowercase().let { "up" in it || "back" in it }
          t?.performAction(if (up) AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
          "scrolled ${if (up) "up" else "down"}"
        }
        "SUBMIT" -> { // the keyboard's send/search/go
          if (Build.VERSION.SDK_INT < 30) throw CodedException("Needs Android 11.")
          n.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
          "pressed enter in $element"
        }
        else -> throw CodedException("Unknown action $action.")
      }
    }
    settle()
    return look(c) + mapOf("status" to "done", "did" to did)
  }

  /** back, home, recents, notifications, screenshot. */
  fun key(c: Context, name: String): Map<String, Any> {
    val s = svc()
    val k = name.lowercase()
    val g = when {
      "back" in k -> AccessibilityService.GLOBAL_ACTION_BACK
      "home" in k -> AccessibilityService.GLOBAL_ACTION_HOME
      "recent" in k -> AccessibilityService.GLOBAL_ACTION_RECENTS
      "notif" in k -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
      "screenshot" in k -> AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT
      else -> throw CodedException("Unknown key $name.")
    }
    s.performGlobalAction(g)
    settle()
    // Always the screen afterwards (after home: the launcher), so the next step sees where it is.
    return look(c) + mapOf("status" to "done", "did" to "pressed $k")
  }

  /** After opening an app: wait until it's the one in front (5 s at most), then look. */
  fun waitFor(c: Context, app: String): Map<String, Any> {
    val until = System.currentTimeMillis() + 5000
    while (System.currentTimeMillis() < until) {
      try {
        val l = look(c)
        if ((l["app"] as String).lowercase().contains(app.lowercase())) { settle(); return look(c) }
      } catch (_: CodedException) {}
      Thread.sleep(250)
    }
    return look(c)
  }
}
