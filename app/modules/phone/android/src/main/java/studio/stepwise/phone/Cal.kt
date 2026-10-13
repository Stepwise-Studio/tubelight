package studio.stepwise.phone

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Instances
import android.provider.CalendarContract.Reminders
import expo.modules.kotlin.exception.CodedException
import java.util.TimeZone

/**
 * The phone's own calendars (Android's calendar provider: the same events Samsung Calendar and Google Calendar show,
 * synced by the phone), for the Tasks tab's calendar: read a range of event instances (repeats expanded), add, edit
 * and delete events. Editing a repeating event changes the whole series.
 */
object Cal {
  fun calendars(c: Context): List<Map<String, Any?>> {
    val out = mutableListOf<Map<String, Any?>>()
    c.contentResolver.query(Calendars.CONTENT_URI, arrayOf(Calendars._ID, Calendars.CALENDAR_DISPLAY_NAME, Calendars.CALENDAR_COLOR,
      Calendars.ACCOUNT_NAME, Calendars.CALENDAR_ACCESS_LEVEL, Calendars.VISIBLE, Calendars.IS_PRIMARY, Calendars.ACCOUNT_TYPE), null, null, null)?.use { cur ->
      while (cur.moveToNext()) out.add(mapOf(
        "id" to cur.getLong(0).toString(), "name" to (cur.getString(1) ?: ""), "color" to hex(cur.getInt(2)),
        "account" to (cur.getString(3) ?: ""), "writable" to (cur.getInt(4) >= Calendars.CAL_ACCESS_CONTRIBUTOR),
        "visible" to (cur.getInt(5) == 1), "primary" to (cur.getInt(6) == 1), "local" to (cur.getString(7) == "LOCAL")))
    }
    return out
  }

  fun events(c: Context, from: Long, to: Long): List<Map<String, Any?>> {
    val uri = Instances.CONTENT_URI.buildUpon().also { ContentUris.appendId(it, from); ContentUris.appendId(it, to) }.build()
    val out = mutableListOf<Map<String, Any?>>()
    c.contentResolver.query(uri, arrayOf(Instances.EVENT_ID, Instances.BEGIN, Instances.END, Instances.TITLE, Instances.ALL_DAY,
      Instances.EVENT_LOCATION, Instances.DESCRIPTION, Instances.DISPLAY_COLOR, Instances.CALENDAR_ID, Instances.RRULE, Instances.VISIBLE),
      null, null, "${Instances.BEGIN} ASC")?.use { cur ->
      while (cur.moveToNext()) {
        if (cur.getInt(10) != 1) continue
        out.add(mapOf(
          "id" to cur.getLong(0).toString(), "start" to cur.getLong(1).toDouble(), "end" to cur.getLong(2).toDouble(),
          "title" to (cur.getString(3) ?: ""), "allDay" to (cur.getInt(4) == 1), "place" to (cur.getString(5) ?: ""),
          "notes" to (cur.getString(6) ?: ""), "color" to hex(cur.getInt(7)), "calendar" to cur.getLong(8).toString(),
          "rrule" to (cur.getString(9) ?: "")))
      }
    }
    return out
  }

  /** Adds (no id) or changes an event: {id?, calendar, title, start, end (ms), allDay, place, notes, rrule, alert (minutes
   *  before, -1 for none; only on a new one)}. All-day events are stored at UTC midnights, as the provider wants. */
  fun save(c: Context, e: Map<String, Any?>): String {
    val allDay = e["allDay"] == true
    val start = (e["start"] as Number).toLong()
    val end = (e["end"] as Number).toLong()
    val rrule = (e["rrule"] as? String).orEmpty()
    val v = ContentValues().apply {
      put(Events.TITLE, (e["title"] as? String).orEmpty())
      put(Events.EVENT_LOCATION, (e["place"] as? String).orEmpty())
      put(Events.DESCRIPTION, (e["notes"] as? String).orEmpty())
      put(Events.ALL_DAY, if (allDay) 1 else 0)
      put(Events.EVENT_TIMEZONE, if (allDay) "UTC" else TimeZone.getDefault().id)
      put(Events.DTSTART, if (allDay) utcMidnight(start) else start)
      if (rrule.isNotEmpty()) {
        put(Events.RRULE, rrule)
        put(Events.DURATION, if (allDay) "P${maxOf(1, ((utcMidnight(end) - utcMidnight(start)) / 86_400_000L))}D" else "P${maxOf(60, (end - start) / 1000)}S")
        putNull(Events.DTEND)
      } else {
        putNull(Events.RRULE); putNull(Events.DURATION)
        put(Events.DTEND, if (allDay) maxOf(utcMidnight(end), utcMidnight(start) + 86_400_000L) else end)
      }
    }
    val id = (e["id"] as? String)?.takeIf { it.isNotEmpty() }
    if (id != null) {
      (e["calendar"] as? String)?.takeIf { it.isNotEmpty() }?.let { v.put(Events.CALENDAR_ID, it.toLong()) }
      c.contentResolver.update(ContentUris.withAppendedId(Events.CONTENT_URI, id.toLong()), v, null, null)
      return id
    }
    v.put(Events.CALENDAR_ID, ((e["calendar"] as? String)?.takeIf { it.isNotEmpty() } ?: throw CodedException("Pick a calendar.")).toLong())
    val uri = c.contentResolver.insert(Events.CONTENT_URI, v) ?: throw CodedException("The calendar didn't take it.")
    val newId = ContentUris.parseId(uri)
    val alert = (e["alert"] as? Number)?.toInt() ?: -1
    if (alert >= 0) c.contentResolver.insert(Reminders.CONTENT_URI, ContentValues().apply {
      put(Reminders.EVENT_ID, newId); put(Reminders.MINUTES, alert); put(Reminders.METHOD, Reminders.METHOD_ALERT)
    })
    return newId.toString()
  }

  fun delete(c: Context, id: String) {
    c.contentResolver.delete(ContentUris.withAppendedId(Events.CONTENT_URI, id.toLong()), null, null)
  }

  /** The UTC midnight of the local day `ms` falls on. */
  private fun utcMidnight(ms: Long): Long {
    val local = java.util.Calendar.getInstance().apply { timeInMillis = ms }
    return java.util.Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
      clear(); set(local.get(java.util.Calendar.YEAR), local.get(java.util.Calendar.MONTH), local.get(java.util.Calendar.DAY_OF_MONTH))
    }.timeInMillis
  }

  private fun hex(color: Int) = String.format("#%06x", color and 0xffffff)
}
