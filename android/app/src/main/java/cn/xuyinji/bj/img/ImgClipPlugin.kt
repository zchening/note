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

    /**
     * 读回系统剪贴板，确认里面**真的**有一张图。
     *
     * 🔴 v3.2.2：复制之后必须验证（用户报障「点了没复制到剪贴板」）。
     *   `copyImage` 回报 ok 只代表"我们调了 setPrimaryClip"，不代表剪贴板里真有图；
     *   JS 侧据此决定是弹「已复制」还是老实降级到分享/预览。
     *
     * 🔴 返回语义**三态**，别简化成布尔：
     *   - `ok:true,  hasImage:true`  剪贴板里确实有图 ⇒ 可以报成功
     *   - `ok:true,  hasImage:false` 读回来了，但里面没图 ⇒ **不许**报成功
     *   - `ok:false`                 **读不回来**（ROM 限制/权限）⇒ 无法证伪，JS 侧信任写入
     *   把"读不回来"和"确实没图"混成一个 false，会让受限 ROM 上的用户
     *   每次导出都被打发到分享面板 —— 那是把取证手段当成了判据。
     */
    @PluginMethod
    fun hasImage(call: PluginCall) {
        val ret = JSObject()
        try {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip
            val desc = clip?.description
            val has = desc != null && (desc.hasMimeType("image/*") || desc.hasMimeType("image/png"))
            ret.put("ok", true)
            ret.put("hasImage", has)
            ret.put("mime", if (desc != null && desc.mimeTypeCount > 0) desc.getMimeType(0) else "")
            if (has) ret.put("uri", clip?.getItemAt(0)?.uri?.toString() ?: "")
        } catch (e: Exception) {
            // 🔴 读不回来 ⇒ ok:false（无法证伪），不是 hasImage:false
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }

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
            // 便于诊断导出（真机报障时可直接看出落的是什么 URI）
            ret.put("uri", uri.toString())
        } catch (e: Exception) {
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }
}
