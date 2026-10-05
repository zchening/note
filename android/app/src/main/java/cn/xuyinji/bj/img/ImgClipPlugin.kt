package cn.xuyinji.bj.img

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.Base64
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

// v7.7.0：「导出为图片并复制」APP 原生桥——Android WebView 的 Async Clipboard 写图片长期不可用，
// JS 侧 clipboard.write 被拒后走本桥：base64 PNG → 缓存目录 → FileProvider content uri →
// ClipboardManager.setPrimaryClip（系统会把该 content uri 的读权限随剪贴板分头发给粘贴方）。
// 与 RemPlugin 同套路：显式 registerPlugin，JS 每次现读 Capacitor.Plugins.ImgClip，失败静默回退。
@CapacitorPlugin(name = "ImgClip")
class ImgClipPlugin : Plugin() {

    @PluginMethod
    fun copyImage(call: PluginCall) {
        val ret = JSObject()
        try {
            val b64 = call.getString("base64") ?: ""
            if (b64.isEmpty()) {
                ret.put("ok", false); ret.put("error", "empty")
                call.resolve(ret); return
            }
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val dir = File(context.cacheDir, "clipimg")
            if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("mkdirs failed")
            val f = File(dir, "note.png")
            f.writeBytes(bytes)
            val authority = context.packageName + ".fileprovider"
            val uri = FileProvider.getUriForFile(context, authority, f)
            val clip = ClipData.newUri(context.contentResolver, "NoteSync 图片", uri)
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(clip)
            ret.put("ok", true)
            ret.put("bytes", bytes.size)
        } catch (e: Exception) {
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }
}
