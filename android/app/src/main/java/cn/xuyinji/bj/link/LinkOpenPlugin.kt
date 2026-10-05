package cn.xuyinji.bj.link

import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// v8.1.0 链接打开方式原生桥（用户挑版A·默认系统浏览器）：
// openExternal = ACTION_VIEW 直开默认浏览器——真机实锤 Capacitor 内建外跳会弹
// 「NoteSync想要打开Chrome」确认框，对老人用户是噪声，直发 Intent 绕开它。
// openInApp = 拉起 LinkViewActivity 子 WebView，主 WebView（笔记编辑态/密钥）零打扰。
// 只收 http/https；tel: 等其它 scheme 由 JS 侧既有路径处理，不进本桥。
// 与 RemPlugin/ImgClip 同套路：MainActivity 显式 registerPlugin，JS 每次现读
// Capacitor.Plugins.LinkOpen，旧版无此桥 JS 侧静默回退 window.open。
@CapacitorPlugin(name = "LinkOpen")
class LinkOpenPlugin : Plugin() {

    private fun safeUrl(call: PluginCall): String? {
        val u = call.getString("url") ?: return null
        return if (u.startsWith("https://") || u.startsWith("http://")) u else null
    }

    @PluginMethod
    fun openExternal(call: PluginCall) {
        val ret = JSObject()
        val u = safeUrl(call)
        if (u == null) { ret.put("ok", false); ret.put("error", "bad url"); call.resolve(ret); return }
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            ret.put("ok", true)
        } catch (e: Exception) {
            ret.put("ok", false); ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun openInApp(call: PluginCall) {
        val ret = JSObject()
        val u = safeUrl(call)
        if (u == null) { ret.put("ok", false); ret.put("error", "bad url"); call.resolve(ret); return }
        try {
            activity.startActivity(
                Intent(activity, LinkViewActivity::class.java)
                    .putExtra("url", u)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            ret.put("ok", true)
        } catch (e: Exception) {
            ret.put("ok", false); ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }
}
