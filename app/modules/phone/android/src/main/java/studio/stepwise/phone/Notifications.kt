package studio.stepwise.phone

import android.app.Notification
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/** Opt-in (Settings → Notification access): remembers the last day of notifications so a teammate can look through
 *  them when asked. Kept on the phone; the app passes them to the server when it opens. */
class NotificationsService : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification) {
    Notes.add(this, sbn)
  }
}

object Notes {
  private const val MAX = 200
  private const val DAY = 24 * 3600 * 1000L
  private fun prefs(c: Context) = c.getSharedPreferences("tubelight.notes", Context.MODE_PRIVATE)

  @Synchronized
  fun add(c: Context, sbn: StatusBarNotification) {
    val n = sbn.notification
    if (sbn.isOngoing || sbn.packageName == c.packageName || n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    val ex = n.extras
    val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
    val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
    if (title.isBlank() && text.isBlank()) return
    val app = try { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(sbn.packageName, 0)).toString() } catch (_: Exception) { sbn.packageName }
    val now = System.currentTimeMillis()
    val old = load(c)
    val keep = JSONArray()
    for (i in 0 until old.length()) {
      val o = old.getJSONObject(i)
      val same = o.optString("package") == sbn.packageName && o.optString("title") == title && o.optString("text") == text.take(500)
      if (now - o.optLong("at") < DAY && !same) keep.put(o)
    }
    keep.put(JSONObject().put("key", "${sbn.key}:${sbn.postTime}").put("app", app).put("package", sbn.packageName)
      .put("title", title).put("text", text.take(500)).put("at", sbn.postTime))
    val trimmed = JSONArray()
    for (i in maxOf(0, keep.length() - MAX) until keep.length()) trimmed.put(keep.get(i))
    prefs(c).edit().putString("items", trimmed.toString()).apply()
  }

  fun since(c: Context, ms: Long): List<Map<String, Any?>> {
    val a = load(c)
    return (0 until a.length()).map { a.getJSONObject(it) }.filter { it.optLong("at") > ms }.map { o ->
      mapOf("key" to o.optString("key"), "app" to o.optString("app"), "title" to o.optString("title"),
        "text" to o.optString("text"), "at" to o.optLong("at").toDouble())
    }
  }

  private fun load(c: Context) = try { JSONArray(prefs(c).getString("items", "[]")) } catch (_: Exception) { JSONArray() }
}
