package cn.xuyinji.bj.rem

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import cn.xuyinji.bj.MainActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(name = "RemBridge")
class RemPlugin : Plugin() {

    data class Reminder(val at: Long, val text: String, val idx: Int = 0, val noteId: String = "")

    companion object {
        const val KEYSTORE_ALIAS = "notesync_rem_key"
        const val PREFS_NAME = "notesync_rem"
        const val KEY_CIPHER = "cipher_b64"   // v5.59 前的单份存储（迁移源，读完即删）
        const val KEY_IV = "iv_b64"
        // v6.0：按笔记分区存储——切到笔记 B 同步时只动 B 的分区，笔记 A 的闹钟分区原样保留，
        // 「A 设了提醒 → 切到 B → A 到点不推送」的根因（全量镜像 + cancelAll 式替换）就此根治。
        fun partCipher(noteId: String) = "cipher_n_" + noteId
        fun partIv(noteId: String) = "iv_n_" + noteId
        // 跨分区唯一稳定 id：旧版 requestCode/notifyId 用分区内 idx（0..9），多分区后会互撞覆盖
        fun stableUid(noteId: String, at: Long): Int = (noteId + "#" + at).hashCode()
        // 🔴 渠道名与 strings.xml 的 app_name 保持一致（"NoteSyncX 提醒"，v1.12.0 用户拍板）：
        //    老项目那条叫 "NoteSync 提醒"，两个 App 同时装时通知栏里必须能分清哪条是谁的。
        //    X 后缀就是为此存在的 —— 见 strings.xml app_name 处的注释。
        // 🔴 NOTIF_CHANNEL_ID 不改（保持 "notesync_reminders"）：渠道 id 是**持久化**的，
        //    改了等于新建一个渠道，用户系统设置里会同时看到两条同名渠道。
        const val NOTIF_CHANNEL_ID = "notesync_reminders"
        const val NOTIF_CHANNEL_NAME = "NoteSyncX 提醒"
        const val ACTION_FIRE = "cn.xuyinji.bj.REM_FIRE"
        const val ACTION_NOTIFY_CLICK = "cn.xuyinji.bj.NOTIFY_CLICK"

        // v5.55：前台标志（MainActivity onResume/onPause 维护）。
        // 前台时 JS 提醒卡+声音已负责，RemReceiver 跳过通知避免双重打扰；
        // 进程被杀重建时默认 false = 推通知，安全方向正确。
        // 必须 @JvmField：@JvmStatic 只生成 get/set 方法，字段仍为 private，
        // Java 侧 RemPlugin.isForeground 字段式访问会编译失败（CI 实锤）。
        @JvmField
        @Volatile
        var isForeground = false

        fun getOrCreateKey(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(KEYSTORE_ALIAS, null) as? SecretKey)?.let { return it }
            val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            kg.init(
                KeyGenParameterSpec.Builder(
                    KEYSTORE_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            return kg.generateKey()
        }

        fun encryptList(items: List<Reminder>): Pair<String, String> {
            val arr = JSONArray()
            for (r in items) {
                val o = JSONObject()
                o.put("at", r.at)
                o.put("text", r.text)
                o.put("idx", r.idx)
                o.put("noteId", r.noteId)
                arr.put(o)
            }
            val plain = arr.toString().toByteArray(Charsets.UTF_8)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val iv = cipher.iv
            val ct = cipher.doFinal(plain)
            return Pair(
                Base64.encodeToString(ct, Base64.NO_WRAP),
                Base64.encodeToString(iv, Base64.NO_WRAP)
            )
        }

        fun decryptList(cB64: String, ivB64: String): List<Reminder> {
            val ct = Base64.decode(cB64, Base64.DEFAULT)
            val iv = Base64.decode(ivB64, Base64.DEFAULT)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            val plain = cipher.doFinal(ct)
            val arr = JSONArray(String(plain, Charsets.UTF_8))
            val list = mutableListOf<Reminder>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                list.add(Reminder(o.getLong("at"), o.optString("text"), 0, o.optString("noteId", "")))
            }
            return list
        }

        /** v6.0：读取单个笔记分区的提醒列表（noteId 以分区 key 为权威，解密后强制回填） */
        fun readPartition(context: Context, noteId: String): List<Reminder> {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val c = prefs.getString(partCipher(noteId), null) ?: return emptyList()
            val iv = prefs.getString(partIv(noteId), null) ?: return emptyList()
            return try {
                decryptList(c, iv)
                    .sortedBy { it.at }
                    .mapIndexed { i, r -> r.copy(idx = i, noteId = noteId) }
            } catch (_: Exception) { emptyList() }
        }

        /** v5.59 前单份存储 → 分区迁移：读旧 key、按旧 idx 取消旧闹钟、落到 "" 分区、删旧 key（防旧 requestCode 残留闹钟反复触发） */
        private fun migrateLegacy(context: Context) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val c = prefs.getString(KEY_CIPHER, null) ?: return
            val iv = prefs.getString(KEY_IV, null) ?: return
            val legacy = try {
                decryptList(c, iv).sortedBy { it.at }.mapIndexed { i, r -> r.copy(idx = i, noteId = "") }
            } catch (_: Exception) { emptyList() }
            for (r in legacy) cancelLegacyAlarm(context, r) // 旧闹钟 requestCode=idx（不是 stableUid），必须按旧码取消
            if (legacy.isNotEmpty()) {
                val (c2, iv2) = encryptList(legacy)
                prefs.edit()
                    .putString(partCipher(""), c2)
                    .putString(partIv(""), iv2)
                    .commit()
                // v6.0 P1 修复：迁移项必须按新 stableUid 重排未来闹钟——上面取消的是旧码，
                // 而新版 sync 只按 noteId 排程本分区，"" 分区不会被 JS 再次排程，不重排则升级后旧提醒静默失效
                val now = System.currentTimeMillis()
                for (r in legacy) if (r.at > now) scheduleAlarm(context, r)
            }
            prefs.edit().remove(KEY_CIPHER).remove(KEY_IV).commit()
        }

        /** v6.0：按旧版 requestCode（分区内 idx）取消升级前的残留闹钟——stableUid 匹配不上旧码 */
        private fun cancelLegacyAlarm(context: Context, r: Reminder) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val intent = Intent(context, RemReceiver::class.java).apply { action = ACTION_FIRE }
            val pi = PendingIntent.getBroadcast(
                context, r.idx, intent,
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
            ) ?: return
            am.cancel(pi)
        }

        fun readItems(context: Context): List<Reminder> {
            migrateLegacy(context)
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val out = mutableListOf<Reminder>()
            val parts = prefs.all.keys.filter { it.startsWith("cipher_n_") }
                .map { it.removePrefix("cipher_n_") }
            for (nid in parts) out.addAll(readPartition(context, nid))
            return out.sortedBy { it.at }.mapIndexed { i, r -> r.copy(idx = i) }
        }

        fun scheduleAlarm(context: Context, r: Reminder) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val uid = stableUid(r.noteId, r.at)
            val intent = Intent(context, RemReceiver::class.java).apply {
                action = ACTION_FIRE
                putExtra("at", r.at)
                putExtra("text", r.text)
                putExtra("idx", r.idx)
                putExtra("noteId", r.noteId)
            }
            val pi = PendingIntent.getBroadcast(
                context, uid, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.at, pi)
            } else {
                val showIntent = PendingIntent.getActivity(
                    context, uid, Intent(context, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                am.setAlarmClock(AlarmManager.AlarmClockInfo(r.at, showIntent), pi)
            }
        }

        fun cancelAlarm(context: Context, r: Reminder) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val intent = Intent(context, RemReceiver::class.java).apply { action = ACTION_FIRE }
            val pi = PendingIntent.getBroadcast(
                context, stableUid(r.noteId, r.at), intent,
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
            ) ?: return
            am.cancel(pi)
        }

        /** 开机/覆盖安装/时间变更后重排所有未来提醒；过期跳过 */
        fun rescheduleAll(context: Context) {
            val items = readItems(context)
            val now = System.currentTimeMillis()
            for (r in items) {
                if (r.at > now) scheduleAlarm(context, r)
            }
        }

        fun createNotificationChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(NOTIF_CHANNEL_ID) != null) return
            val ch = NotificationChannel(NOTIF_CHANNEL_ID, NOTIF_CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH)
            ch.description = "NoteSync 时间提醒，关掉 App 也能推"
            ch.enableVibration(true)
            ch.setBypassDnd(true)
            ch.setShowBadge(true)
            nm.createNotificationChannel(ch)
        }
    }

    private val prefs by lazy {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    override fun load() {
        super.load()
        createNotificationChannel(context)
        // P0：Android 13+ 通知权限不自动授予，必须运行时申请，否则提醒一条都不弹
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
        ) {
            getActivity()?.let {
                ActivityCompat.requestPermissions(
                    it,
                    arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                    1001
                )
            }
        }
    }

    @PluginMethod
    fun sync(call: PluginCall) {
        try {
            val listJson = call.getArray("list") ?: JSONArray()
            // v6.0：分区 upsert——只替换当前笔记的分区，其他分区（含已排闹钟）一律不动。
            // 这是「A 设提醒 → 切到 B → A 到点仍推送」的核心。
            val nid = call.getString("noteId") ?: ""
            val now = System.currentTimeMillis()
            val items = mutableListOf<Reminder>()
            for (i in 0 until listJson.length()) {
                val o = listJson.getJSONObject(i)
                val at = o.optLong("at", 0)
                val text = o.optString("text", "")
                if (at > now - 60_000L) items.add(Reminder(at, text, 0, nid))
            }
            items.sortBy { it.at }
            val itemsWithIdx = items.mapIndexed { i, r -> r.copy(idx = i) }
            migrateLegacy(context) // v6.0：升级首同步即清旧码闹钟（幂等，无旧 key 时零成本）
            // 只清本分区旧 alarm（基于旧分区内容，跨分区零影响）
            for (r in readPartition(context, nid)) cancelAlarm(context, r)
            // 落盘加密 + 排程（同步落盘，防进程被杀丢提醒）
            val (c, iv) = encryptList(itemsWithIdx)
            prefs.edit()
                .putString(partCipher(nid), c)
                .putString(partIv(nid), iv)
                .commit()
            var scheduled = 0
            for (r in itemsWithIdx) {
                scheduleAlarm(context, r)
                scheduled++
            }
            val ret = JSObject()
            ret.put("scheduled", scheduled)
            ret.put("failed", 0)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("sync error: ${e.message}", e)
        }
    }

    @PluginMethod
    fun cancelAll(call: PluginCall) {
        try {
            val items = readItems(context)
            for (r in items) cancelAlarm(context, r)
            prefs.edit().remove(KEY_CIPHER).remove(KEY_IV).commit()
            call.resolve()
        } catch (e: Exception) {
            call.reject("cancelAll error: ${e.message}", e)
        }
    }

    @PluginMethod
    fun getVersion(call: PluginCall) {
        try {
            val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
            val ret = JSObject()
            ret.put("nativeVersion", pkg.versionName ?: "unknown")
            ret.put("scheduled", readItems(context).size)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("version error: ${e.message}", e)
        }
    }

    /** v5.56：主文档缓存与拦截计数只读诊断（?diag 浮层读取——离线兜底断在哪一环一眼看清）。
     *  v10.1.0 D：补冷启主文档链路埋点。boot* 一律为相对 onCreate 入口的毫秒（0=该环节未发生）；
     *  mainDocSrc=disk/asset/net/none 指本轮主文档由谁供；bgRefresh 记后台公网核对结果。
     *  「装完第一次打开慢」这类问题从此不靠手感，?diag 一眼看清卡在哪一环。只读，零行为影响。 */
    @PluginMethod
    fun cacheInfo(call: PluginCall) {
        try {
            val f = java.io.File(context.filesDir, "cached_index.html")
            val ret = JSObject()
            ret.put("exists", f.exists())
            ret.put("size", if (f.exists()) f.length() else 0)
            ret.put("intercept", MainActivity.interceptCount)
            ret.put("fetchFail", MainActivity.fetchFailCount)
            ret.put("cacheHit", MainActivity.cacheHitCount)
            ret.put("assetHit", MainActivity.assetHitCount)
            ret.put("mainDocSrc", MainActivity.mainDocSrc)
            ret.put("mainDocBytes", MainActivity.mainDocBytes)
            ret.put("bootServeAt", MainActivity.bootServeAt)
            ret.put("bootPageDoneAt", MainActivity.bootPageDoneAt)
            ret.put("bootCurtainAt", MainActivity.bootCurtainAt)
            ret.put("bootBgRefreshMs", MainActivity.bootBgRefreshMs)
            ret.put("bgRefresh", MainActivity.bgRefreshResult)
            ret.put("bootReload", MainActivity.bootInterceptorReload)
            ret.put("diskVerOk", MainActivity.cacheDiskIsCurrentVersion)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("cacheInfo error: ${e.message}", e)
        }
    }

    /** 精确闹钟权限未授予时，引导用户到系统设置页授予 */
    @PluginMethod
    fun requestExactAlarm(call: PluginCall) {
        try {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                    data = Uri.parse("package:" + context.packageName)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            }
            val ret = JSObject()
            // canScheduleExactAlarms() 是 API 31 才有的方法，minSdk 23 —— 低版本必须短路，否则 NoSuchMethodError
            val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
            ret.put("canScheduleExactAlarms", canExact)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("requestExactAlarm error: ${e.message}", e)
        }
    }
}
