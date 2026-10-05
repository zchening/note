package cn.xuyinji.bj.rem

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import cn.xuyinji.bj.MainActivity
import cn.xuyinji.bj.R

class RemReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != RemPlugin.ACTION_FIRE) return
        val at = intent.getLongExtra("at", 0)
        val text = intent.getStringExtra("text") ?: "该看笔记了"
        val idx = intent.getIntExtra("idx", 0)
        val noteId = intent.getStringExtra("noteId") ?: "" // v6.0：跨笔记——点击进提醒所属的笔记
        // v5.54：过期提醒彻底静默——精确闹钟正常触发时 now-at≈0；
        // 非 precise 兜底（setAndAllowWhileIdle）在系统深睡后补触发会晚到数分钟，
        // 晚到超过 60 秒一律丢弃不发通知（用户拍板：错过的不再弹）。
        if (at <= 0 || System.currentTimeMillis() - at > 60_000L) return
        // v5.55：前台时 JS 提醒卡+声音已负责，不重复推通知；
        // 非前台（后台/Home 切走/彻底关闭被杀/冷启拉起）一律推通知栏（用户拍板语义）
        if (RemPlugin.isForeground) return
        RemPlugin.createNotificationChannel(context)
        val uid = RemPlugin.stableUid(noteId, at) // v6.0：跨分区唯一，防不同笔记同 idx 通知互撞

        // 点击通知 → 回 MainActivity → onNewIntent → JS 收 rem-notify-click(detail.noteId) 跳对应笔记
        val clickIntent = Intent(context, MainActivity::class.java).apply {
            action = RemPlugin.ACTION_NOTIFY_CLICK
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("at", at)
            putExtra("noteId", noteId)
        }
        val pi = PendingIntent.getActivity(
            context, uid, clickIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(context, RemPlugin.NOTIF_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("\u23F0 NoteSync 提醒")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true) // 锁屏强弹（需 USE_FULL_SCREEN_INTENT 权限）
            .build()

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(uid, notif) // v6.0：id 用跨分区稳定 uid（旧 idx 在多分区下会互撞覆盖）
    }
}
