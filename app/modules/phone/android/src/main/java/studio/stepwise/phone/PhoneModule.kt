package studio.stepwise.phone

import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.usage.StorageStatsManager
import android.app.ActivityManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Environment
import android.os.Process
import android.os.StatFs
import android.os.storage.StorageManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The phone side of Tubelight: things a teammate asks the phone to do (alarms, timers, calls, texts, maps, calendar,
 * apps), what was on screen when the assistant was summoned, notification access, and the "Tubelight needs you"
 * alert that opens the assistant panel over the lock screen.
 */
class PhoneModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw CodedException("Tubelight isn't running.")

  override fun definition() = ModuleDefinition {
    Name("Phone")

    Function("act") { a: Map<String, Any?> -> act(a) }
    // The name the phone goes by (Settings → About phone), for its teammate: "Galaxy S21 FE 5G".
    Function("deviceName") { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL }
    Function("screenContext") { ScreenContext.take() }
    Function("launchArgs") {
      val ex = appContext.currentActivity?.intent?.extras
      val out = mutableMapOf<String, String?>()
      ex?.keySet()?.filter { it.startsWith("tl_") }?.forEach { out[it.removePrefix("tl_")] = ex.getString(it) }
      out
    }
    Function("isLocked") {
      val kg = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      kg.isKeyguardLocked || !pm.isInteractive
    }
    Function("ring") { a: Map<String, Any?> -> ring(a) }
    Function("clearRing") { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(RING_ID) }
    Function("canRing") {
      Build.VERSION.SDK_INT < 34 || (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).canUseFullScreenIntent()
    }
    Function("openRingSettings") {
      val i = if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
        else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      start(i)
    }
    Function("notificationAccess") {
      Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners").orEmpty().contains(context.packageName)
    }
    Function("openNotificationAccess") { start(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
    Function("appsOn") { Apps.on(context) }
    Function("openAppsAccess") { start(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
    AsyncFunction("appLook") { Apps.look(context) }
    AsyncFunction("appAct") { snapshot: String, element: String, action: String, value: String -> Apps.act(context, snapshot, element, action, value) }
    AsyncFunction("appKey") { key: String -> Apps.key(context, key) }
    AsyncFunction("appOpen") { app: String -> act(mapOf("action" to "open_app", "app" to app)); Apps.waitFor(context, app) }
    // The call stand-in (Calls.kt).
    Function("standIn") { mapOf("on" to Calls.on(context), "answer" to Calls.canAnswer(context), "access" to Calls.canSwitchAccess(context)) }
    Function("setStandIn") { on: Boolean -> Calls.set(context, on) }
    Function("callState") { Calls.state(context) }
    Function("callAnswer") { Calls.clear(context); Calls.answer(context) }
    Function("callHangUp") { Calls.hangUp(context) }
    Function("callSpeaker") { on: Boolean -> Calls.speaker(context, on) }
    Function("standInAccess") { on: Boolean -> Calls.access(context, on) }
    Function("canDnd") { Controls.canDnd(context) }
    Function("openDndAccess") { start(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)) }
    Function("canBrightness") { Settings.System.canWrite(context) }
    Function("openBrightnessAccess") { start(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${context.packageName}"))) }
    Function("recentNotifications") { since: Double -> Notes.since(context, since.toLong()) }
    Function("usageAccess") { usageAccess() }
    Function("openUsageAccess") { start(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }
    AsyncFunction("status") { status() } // off the JS thread: it reads storage, the calendar and the call log
    AsyncFunction("pdfInfo") { path: String -> Pdf.info(path) }
    AsyncFunction("pdfPage") { path: String, page: Int, width: Int -> Pdf.render(context, path, page, width) }
    AsyncFunction("pdfSearch") { path: String, query: String, limit: Int -> Pdf.search(path, query, limit) }
    Function("pdfClose") { Pdf.close() }
    AsyncFunction("openFile") { uri: String -> Opened.take(context, uri) }
    // The display's own corner radius in dp (Android 12+ reports it), so a glow can hug the screen's rounded edge.
    Function("screenRadius") {
      val insets = appContext.currentActivity?.window?.decorView?.rootWindowInsets
      val px = if (Build.VERSION.SDK_INT >= 31) insets?.getRoundedCorner(android.view.RoundedCorner.POSITION_BOTTOM_LEFT)?.radius ?: 0 else 0
      px / context.resources.displayMetrics.density
    }
  }

  private fun start(i: Intent) {
    val activity = appContext.currentActivity
    try {
      if (activity != null) activity.startActivity(i) else context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (e: ActivityNotFoundException) {
      throw CodedException("No app on this phone can do that.")
    }
  }

  private fun usageAccess(): Boolean {
    val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    @Suppress("DEPRECATION")
    return ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
  }

  /** What Shelby can tell about the phone: storage (and, with usage access, what's taking it), battery, memory,
   *  network. Read when the app opens or a message goes out, and passed to the server. */
  private fun status(): Map<String, Any?> {
    val fs = StatFs(Environment.getDataDirectory().path)
    val out = mutableMapOf<String, Any?>(
      "model" to (Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL),
      "android" to Build.VERSION.RELEASE,
      "storage_total" to fs.totalBytes.toDouble(), "storage_free" to fs.availableBytes.toDouble(),
    )
    val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    out["battery"] = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    out["charging"] = bm.isCharging
    val mi = ActivityManager.MemoryInfo().also { (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(it) }
    out["memory_total"] = mi.totalMem.toDouble(); out["memory_free"] = mi.availMem.toDouble()
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val caps = cm.getNetworkCapabilities(cm.activeNetwork)
    out["network"] = when {
      caps == null -> "offline"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile data"
      else -> "online"
    }
    // Android lets apps read only the next alarm (the one the status bar shows), never the whole list.
    (context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager).nextAlarmClock?.let { n ->
      out["next_alarm"] = n.triggerTime.toDouble()
      out["next_alarm_app"] = n.showIntent?.creatorPackage?.let { pkg ->
        try { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(pkg, 0)).toString() } catch (_: Exception) { pkg }
      }
    }
    Controls.calendar(context)?.let { out["calendar"] = it }
    Controls.calls(context)?.let { out["calls"] = it }
    Controls.nowPlaying(context)?.let { out["playing"] = it }
    out["can"] = mapOf("contacts" to Controls.granted(context, android.Manifest.permission.READ_CONTACTS),
      "call" to Controls.granted(context, android.Manifest.permission.CALL_PHONE), "sms" to Controls.granted(context, android.Manifest.permission.SEND_SMS),
      "dnd" to Controls.canDnd(context), "brightness" to Settings.System.canWrite(context), "apps" to Apps.on(context))
    out["usage_access"] = usageAccess()
    if (Build.VERSION.SDK_INT >= 26 && usageAccess()) {
      try {
        val ssm = context.getSystemService(Context.STORAGE_STATS_SERVICE) as StorageStatsManager
        val user = Process.myUserHandle()
        val ext = ssm.queryExternalStatsForUser(StorageManager.UUID_DEFAULT, user)
        out["kinds"] = mapOf("photos" to ext.imageBytes.toDouble(), "videos" to ext.videoBytes.toDouble(),
          "audio" to ext.audioBytes.toDouble(), "other files" to (ext.totalBytes - ext.imageBytes - ext.videoBytes - ext.audioBytes - ext.appBytes).toDouble())
        val pm = context.packageManager
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
          .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }.distinctBy { it.first }
        out["apps"] = apps.mapNotNull { (pkg, label) ->
          try {
            val st = ssm.queryStatsForPackage(StorageManager.UUID_DEFAULT, pkg, user)
            mapOf("name" to label, "bytes" to (st.appBytes + st.dataBytes + st.cacheBytes).toDouble(), "cache" to st.cacheBytes.toDouble())
          } catch (_: Exception) { null }
        }.sortedByDescending { it["bytes"] as Double }.take(15)
      } catch (_: Exception) {}
    }
    return out
  }

  private fun str(a: Map<String, Any?>, k: String) = (a[k] as? String)?.trim().orEmpty()
  private fun num(a: Map<String, Any?>, k: String) = (a[k] as? Number)?.toLong() ?: 0L

  /** One action; returns what happened, in a few words. */
  private fun act(a: Map<String, Any?>): String {
    val enc = { s: String -> Uri.encode(s) }
    when (str(a, "action")) {
      "alarm" -> {
        val h = num(a, "hour").toInt(); val m = num(a, "minute").toInt()
        start(Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, h).putExtra(AlarmClock.EXTRA_MINUTES, m)
          .putExtra(AlarmClock.EXTRA_MESSAGE, str(a, "title").ifEmpty { "Tubelight" }).putExtra(AlarmClock.EXTRA_SKIP_UI, true))
        return "Alarm set for %02d:%02d".format(h, m)
      }
      "timer" -> {
        val s = num(a, "seconds").toInt()
        start(Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, s)
          .putExtra(AlarmClock.EXTRA_MESSAGE, str(a, "title").ifEmpty { "Tubelight" }).putExtra(AlarmClock.EXTRA_SKIP_UI, true))
        return "Timer started"
      }
      "call" -> {
        val (who, number) = person(a)
        // Straight through when they let Tubelight make calls and the name matched; otherwise the dialer, ready.
        if (Controls.granted(context, android.Manifest.permission.CALL_PHONE)) {
          start(Intent(Intent.ACTION_CALL, Uri.parse("tel:${enc(number)}"))); return "Calling $who"
        }
        start(Intent(Intent.ACTION_DIAL, Uri.parse("tel:${enc(number)}"))); return "Dialer opened for $who"
      }
      "text" -> {
        val (who, number) = person(a)
        start(Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:${enc(number)}")).putExtra("sms_body", str(a, "text")))
        return "Message to $who ready to send"
      }
      "sms" -> { // sent as it is: only after their OK (the server's phone_send asks first)
        if (!Controls.granted(context, android.Manifest.permission.SEND_SMS)) throw CodedException("Allow SMS first: Profile → Phone assistant.")
        val (who, number) = person(a)
        val sm = context.getSystemService(android.telephony.SmsManager::class.java)
        sm.sendMultipartTextMessage(number, null, sm.divideMessage(str(a, "text")), null, null)
        return "Sent to $who"
      }
      "reply" -> return Replies.send(context, str(a, "key"), str(a, "text"))
      "flashlight" -> return Controls.flashlight(context, str(a, "text") != "off")
      "volume" -> return Controls.volume(context, str(a, "text"), num(a, "level").toInt())
      "dnd" -> return Controls.dnd(context, str(a, "text") != "off")
      "brightness" -> return Controls.brightness(context, num(a, "level").toInt())
      "media" -> return Controls.media(context, str(a, "text").lowercase())
      "play" -> { // "play X on Spotify": the standard play-from-search, which music apps start playing
        val i = Intent(android.provider.MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH).putExtra(SearchManager.QUERY, str(a, "text"))
          .putExtra(android.provider.MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
        val want = str(a, "app").lowercase()
        // The app they named, if it's installed; otherwise whatever plays music here (Android asks if there's a choice).
        MUSIC.entries.firstOrNull { want.isNotEmpty() && want.contains(it.key) }?.value
          ?.takeIf { context.packageManager.getLaunchIntentForPackage(it) != null }?.let { i.setPackage(it) }
        start(i); return "Playing ${str(a, "text")}"
      }
      "timers" -> { start(Intent(AlarmClock.ACTION_SHOW_TIMERS)); return "Timers opened" }
      // Android can only silence a timer that's ringing (and Samsung's clock ignores even that), never cancel a running
      // countdown: the timers open for them to stop it.
      "timer_off" -> { start(Intent(AlarmClock.ACTION_SHOW_TIMERS)); return "Opened your timers: stop it there" }
      "snooze" -> { start(Intent(AlarmClock.ACTION_SNOOZE_ALARM)); return "Asked the clock to snooze it" }
      "alarm_off" -> { // a ringing alarm, or one by time or label; whether the clock app obeys is up to it
        val i = Intent(AlarmClock.ACTION_DISMISS_ALARM)
        when {
          a["hour"] != null -> i.putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, AlarmClock.ALARM_SEARCH_MODE_TIME)
            .putExtra(AlarmClock.EXTRA_HOUR, num(a, "hour").toInt()).putExtra(AlarmClock.EXTRA_MINUTES, num(a, "minute").toInt())
          str(a, "title").isNotEmpty() -> i.putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, AlarmClock.ALARM_SEARCH_MODE_LABEL)
            .putExtra(AlarmClock.EXTRA_MESSAGE, str(a, "title"))
          else -> i.putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, AlarmClock.ALARM_SEARCH_MODE_NEXT)
        }
        start(i)
        // Samsung's clock answers with the alarm list rather than turning one off (checked on a Galaxy, 2026-10-11).
        return if (Build.MANUFACTURER.equals("samsung", true)) "Opened your alarms: switch it off there" else "Asked the clock to turn it off"
      }
      "photo" -> { start(Intent(android.provider.MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)); return "Camera opened" }
      "panel" -> { // the switches apps can't flip themselves (Android 10+): their own panel opens
        val page = str(a, "text").lowercase()
        start(Intent(when {
          "wi" in page -> Settings.Panel.ACTION_WIFI
          "internet" in page || "data" in page -> Settings.Panel.ACTION_INTERNET_CONNECTIVITY
          "nfc" in page -> Settings.Panel.ACTION_NFC
          "volume" in page -> Settings.Panel.ACTION_VOLUME
          "bluetooth" in page -> Settings.ACTION_BLUETOOTH_SETTINGS
          "battery" in page || "saver" in page -> Settings.ACTION_BATTERY_SAVER_SETTINGS
          "airplane" in page || "flight" in page -> Settings.ACTION_AIRPLANE_MODE_SETTINGS
          "location" in page -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
          else -> Settings.ACTION_SETTINGS
        }))
        return "Opened, flip it there"
      }
      "whatsapp" -> {
        val digits = person(a).second.filter { it.isDigit() }
        start(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$digits?text=${enc(str(a, "text"))}")))
        return "WhatsApp opened"
      }
      "email" -> {
        start(Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:")).putExtra(Intent.EXTRA_EMAIL, arrayOf(str(a, "to")))
          .putExtra(Intent.EXTRA_SUBJECT, str(a, "title")).putExtra(Intent.EXTRA_TEXT, str(a, "text")))
        return "Email ready to send"
      }
      "navigate" -> {
        val q = enc(str(a, "place"))
        try { start(Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=$q"))) }
        catch (_: CodedException) { start(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=$q"))) }
        return "Directions opened"
      }
      "open_url" -> { start(Intent(Intent.ACTION_VIEW, Uri.parse(str(a, "url")))); return "Opened" }
      "alarms" -> { start(Intent(AlarmClock.ACTION_SHOW_ALARMS)); return "Alarms opened" }
      "settings" -> {
        val page = str(a, "text").lowercase()
        start(Intent(when {
          "storage" in page -> Settings.ACTION_INTERNAL_STORAGE_SETTINGS
          "battery" in page -> Intent.ACTION_POWER_USAGE_SUMMARY
          "wi" in page && "fi" in page -> Settings.ACTION_WIFI_SETTINGS
          "bluetooth" in page -> Settings.ACTION_BLUETOOTH_SETTINGS
          "display" in page || "brightness" in page -> Settings.ACTION_DISPLAY_SETTINGS
          "app" in page -> Settings.ACTION_APPLICATION_SETTINGS
          "sound" in page || "volume" in page -> Settings.ACTION_SOUND_SETTINGS
          "location" in page -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
          else -> Settings.ACTION_SETTINGS
        }))
        return "Settings opened"
      }
      "search" -> { start(Intent(Intent.ACTION_WEB_SEARCH).putExtra(SearchManager.QUERY, str(a, "text"))); return "Searched" }
      "calendar" -> {
        start(Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
          .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, num(a, "start")).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, num(a, "end"))
          .putExtra(CalendarContract.Events.TITLE, str(a, "title")).putExtra(CalendarContract.Events.EVENT_LOCATION, str(a, "place"))
          .putExtra(CalendarContract.Events.DESCRIPTION, str(a, "text")))
        return "Event ready to save"
      }
      "open_app" -> {
        val want = str(a, "app").lowercase()
        val pm = context.packageManager
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        val hit = apps.firstOrNull { it.activityInfo.packageName.lowercase() == want || it.loadLabel(pm).toString().lowercase() == want }
          ?: apps.firstOrNull { it.loadLabel(pm).toString().lowercase().contains(want) }
          ?: throw CodedException("No app called ${str(a, "app")} on this phone.")
        start(pm.getLaunchIntentForPackage(hit.activityInfo.packageName) ?: throw CodedException("That app can't be opened."))
        return "Opened ${hit.loadLabel(pm)}"
      }
      else -> throw CodedException("Unknown phone action ${str(a, "action")}.")
    }
  }

  /** Who to reach: the number given, or a contact found by name on the phone. */
  private fun person(a: Map<String, Any?>): Pair<String, String> {
    str(a, "number").takeIf { it.isNotBlank() }?.let { return (str(a, "name").ifBlank { it }) to it }
    val name = str(a, "name").ifBlank { throw CodedException("Who? Give a name or a number.") }
    return Controls.contact(context, name) ?: throw CodedException("No contact called $name on this phone.")
  }

  /** Over the lock screen (or with the screen off): a full-screen alert that opens the assistant panel on the
   *  decision waiting. Unlocked and in use, the normal notification is enough: returns false. */
  private fun ring(a: Map<String, Any?>): Boolean {
    val kg = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (Build.VERSION.SDK_INT < 26 || (!kg.isKeyguardLocked && power.isInteractive)) return false
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(NotificationChannel(RING_CHANNEL, "Tubelight needs you", NotificationManager.IMPORTANCE_HIGH)
      .apply { description = "A teammate needs a decision while your phone is locked" })
    val open = Intent().setClassName(context.packageName, "${context.packageName}.AssistActivity")
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    for ((k, v) in a) if (v is String) open.putExtra("tl_$k", v)
    val pi = PendingIntent.getActivity(context, RING_ID, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName).takeIf { it != 0 }
      ?: context.applicationInfo.icon
    nm.notify(RING_ID, Notification.Builder(context, RING_CHANNEL)
      .setSmallIcon(icon).setContentTitle(str(a, "title")).setContentText(str(a, "body"))
      .setCategory(Notification.CATEGORY_REMINDER).setFullScreenIntent(pi, true).setContentIntent(pi)
      .setAutoCancel(true).setTimeoutAfter(120_000).build())
    return true
  }

  companion object {
    private val MUSIC = mapOf("spotify" to "com.spotify.music", "youtube" to "com.google.android.apps.youtube.music",
      "apple" to "com.apple.android.music",
      "jiosaavn" to "com.jio.media.jiobeats", "saavn" to "com.jio.media.jiobeats", "amazon" to "com.amazon.mp3", "wynk" to "com.bsbportal.music")
    private const val RING_ID = 4711
    private const val RING_CHANNEL = "tl-ring"
  }
}
