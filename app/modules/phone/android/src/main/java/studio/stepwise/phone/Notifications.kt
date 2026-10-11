package studio.stepwise.phone

import android.app.Notification
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/** Opt-in (Settings → Notification access): remembers the last day of notifications so a teammate can look through
 *  them when asked. Kept on the phone; the app passes them to the server when it opens. */
class NotificationsService : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification) {
    Calls.seen(this, sbn) // a ringing call: offer the stand-in
    Notes.add(this, sbn)
  }
}

/**
 * Replying from a notification, the way a watch does: a messaging app's notification carries a reply action
 * (RemoteInput); filling it in sends the reply in that app (WhatsApp, Telegram, Messages, Slack…). Kept in memory
 * while the notification is fresh; only sent after the user's OK (the server's phone_send asks first).
 */
object Replies {
  private val actions = object : LinkedHashMap<String, Notification.Action>() {
    override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Notification.Action>) = size > 100
  }

  fun replyAction(n: Notification): Notification.Action? =
    n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }

  @Synchronized fun keep(key: String, a: Notification.Action) { actions[key] = a }

  @Synchronized
  fun send(c: Context, key: String, text: String): String {
    val a = actions[key] ?: throw expo.modules.kotlin.exception.CodedException(
      "That conversation's notification is gone (or the phone restarted): open the app to reply.")
    val inputs = a.remoteInputs.filter { it.allowFreeFormInput }
    val results = Bundle().apply { inputs.forEach { putCharSequence(it.resultKey, text) } }
    val intent = Intent()
    RemoteInput.addResultsToIntent(inputs.toTypedArray(), intent, results)
    a.actionIntent.send(c, 0, intent)
    return "Replied"
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
    val key = "${sbn.key}:${sbn.postTime}"
    val reply = Replies.replyAction(n)?.also { Replies.keep(key, it) } != null
    keep.put(JSONObject().put("key", key).put("app", app).put("package", sbn.packageName)
      .put("title", title).put("text", text.take(500)).put("at", sbn.postTime).put("reply", reply))
    val trimmed = JSONArray()
    for (i in maxOf(0, keep.length() - MAX) until keep.length()) trimmed.put(keep.get(i))
    prefs(c).edit().putString("items", trimmed.toString()).apply()
  }

  fun since(c: Context, ms: Long): List<Map<String, Any?>> {
    val a = load(c)
    return (0 until a.length()).map { a.getJSONObject(it) }.filter { it.optLong("at") > ms }.map { o ->
      mapOf("key" to o.optString("key"), "app" to o.optString("app"), "title" to o.optString("title"),
        "text" to o.optString("text"), "at" to o.optLong("at").toDouble(), "reply" to o.optBoolean("reply"))
    }
  }

  private fun load(c: Context) = try { JSONArray(prefs(c).getString("items", "[]")) } catch (_: Exception) { JSONArray() }
}
