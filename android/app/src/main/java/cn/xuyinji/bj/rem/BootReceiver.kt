package cn.xuyinji.bj.rem

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val a = intent.action ?: return
        if (a != Intent.ACTION_BOOT_COMPLETED &&
            a != Intent.ACTION_MY_PACKAGE_REPLACED &&
            a != "android.intent.action.QUICKBOOT_POWERON" &&
            a != Intent.ACTION_TIME_CHANGED &&
            a != Intent.ACTION_TIMEZONE_CHANGED
        ) return
        // 开机/覆盖安装/快速开机/时间或时区变更后，重排所有未来提醒。
        // 用 goAsync 把工作移到后台线程，避免在主线程跑 Keystore/Cipher 触发 ANR。
        val pendingResult = goAsync()
        Thread {
            try {
                RemPlugin.rescheduleAll(context)
            } finally {
                pendingResult.finish()
            }
        }.start()
    }
}
