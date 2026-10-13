package cn.xuyinji.bj.img

import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// v3.2.4：导出长图「分享」APP 原生桥（移动端导出弹窗第①分享档）。
// 为什么必须有这座桥（JS 侧 native-img-share.ts 同一段实锤）：
//   · 壳内 WebView 没有 navigator.share —— Web Share API 是 Chrome 特性，
//     WebView 不实现（DiagExportPlugin.kt 注释双实锤）；
//   · 剪贴板那条路微信不认（v3.2.3：微信 Android 不支持粘贴剪贴板图片）；
//   · 用户拍板「点击分享后调用系统分享组件，跟分享整个诊断报告一样」——
//     诊断报告分享 = DiagExport.shareText（ACTION_SEND），本桥是它的图片版。
// 落点：**cacheDir** 临时文件 + FileProvider（file_paths.xml 的 cache-path 项
// v9.3.0 前就已全开）。不落相册（那是「保存到相册」按钮的事，ImgSave 管）、
// 不落 Download（不留用户可见垃圾，缓存系统自行回收）。
// 零新权限：FileProvider grantUriPermissions 授权接收方读 content:// URI。
// 与 ImgSave / DiagExport 同套路：显式 registerPlugin（MainActivity），
// JS 每次现读 Capacitor.Plugins.ImgShare，读不到就走网页 navigator.share 降级。
@CapacitorPlugin(name = "ImgShare")
class ImgSharePlugin : Plugin() {

    @PluginMethod
    fun shareImage(call: PluginCall) {
        val ret = JSObject()
        try {
            val b64 = call.getString("base64") ?: ""
            if (b64.isEmpty()) {
                ret.put("ok", false); ret.put("error", "empty")
                call.resolve(ret); return
            }
            val mime = call.getString("mime") ?: "image/png"
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                ret.put("ok", false); ret.put("error", "empty")
                call.resolve(ret); return
            }
            val ext = when {
                mime.contains("png") -> "png"; mime.contains("gif") -> "gif"
                mime.contains("webp") -> "webp"; else -> "jpg"
            }
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            // cacheDir/NoteSyncShare/：FileProvider 的 cache-path 已全开（path="."），
            // 子目录自建以便一次清空。同名覆盖无所谓——分享的是当次内容。
            val dir = File(context.cacheDir, "NoteSyncShare")
            if (!dir.exists()) dir.mkdirs()
            val f = File(dir, "note-share-$stamp.$ext")
            f.writeBytes(bytes)
            val uri: Uri = FileProvider.getUriForFile(
                context, context.packageName + ".fileprovider", f
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, "NoteSync")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            // NEW_TASK 与 DiagExport.shareText / UpdatePlugin 同口径：Plugin 的
            // context 不保证是 Activity，startActivity 需要它。
            val chooser = Intent.createChooser(send, "分享图片").apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            // 用户随后在面板里点取消，native 侧收不到回执——一律按"已拉起"算，
            // 不打扰（DiagExport.shareText 同款口径，JS 侧 AbortError 静默同源）。
            ret.put("ok", true); ret.put("shared", true)
        } catch (e: Exception) {
            // 无应用能接 ACTION_SEND / ROM 拦 startActivity / FileProvider 配置缺失
            // ⇒ ok:false，JS 降级到网页 navigator.share，不静默。
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }
}
