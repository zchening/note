package cn.xuyinji.bj.img

import android.content.ContentValues
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// v9.2.0：正文图片「保存到相册」APP 原生桥。
// 为什么必须走原生：壳内 `<a download>` 是哑弹（v8.0.8 导出图片链路已实锤并在 JS 侧留了回退阶梯），
// 而用户拍板「App 壳里点保存图片要真存进相册」。
// 零新权限的设计：
//   · API 29+（Android 10）→ MediaStore 带 RELATIVE_PATH=Pictures/NoteSync，分区存储下不需要写权限；
//   · API 23–28 → 写应用外部目录 getExternalFilesDir(Pictures)/NoteSync 后发 MediaScanner 广播，
//     预 Q 的扫描器会把它收进系统图库，同样不需要 WRITE_EXTERNAL_STORAGE。
// 与 ImgClip / RemPlugin 同套路：显式 registerPlugin，JS 每次现读 Capacitor.Plugins.ImgSave，失败静默回退。
@CapacitorPlugin(name = "ImgSave")
class ImgSavePlugin : Plugin() {

    // 不加（也不能加）@NonBlocking：Capacitor 7 的 annotation 包里根本没有该类，写了 APK 直接
    // unresolved reference 编译失败；且 Bridge.java:217 `taskHandler = new Handler(handlerThread.getLooper())`
    // 说明插件方法本来就派发在专用后台线程，base64 解码与写盘不占 UI 线程（闸 R2b 命中 + 本地源码复核）。
    @PluginMethod
    fun saveImage(call: PluginCall) {
        val ret = JSObject()
        try {
            val b64 = call.getString("base64") ?: ""
            if (b64.isEmpty()) {
                ret.put("ok", false); ret.put("error", "empty")
                call.resolve(ret); return
            }
            val mime = call.getString("mime") ?: "image/jpeg"
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            val ext = when {
                mime.contains("png") -> "png"; mime.contains("gif") -> "gif"
                mime.contains("webp") -> "webp"; else -> "jpg"
            }
            val name = "notesync-$stamp.$ext"
            val saved = if (Build.VERSION.SDK_INT >= 29) viaMediaStore(name, mime, bytes)
                        else viaExternalFile(name, bytes)
            if (saved == null) {
                ret.put("ok", false); ret.put("error", "save-failed")
            } else {
                ret.put("ok", true); ret.put("path", saved); ret.put("bytes", bytes.size)
            }
        } catch (e: Exception) {
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }

    // v9.3.0：JS 侧「保存到相册」主路径改走本方法——App 内 https 直链由原生下载字节再存，
    // 不再依赖 WebView fetch（Cloudinary 偶发 CORS/缓存失败正是「点保存变打开链接」的根因）。
    // 与 saveImage 共用落盘通道；64MB 上限防空转；全程 resolve 不 reject，失败原因进 error。
    @PluginMethod
    fun saveImageUrl(call: PluginCall) {
        val ret = JSObject()
        try {
            val raw = call.getString("url") ?: ""
            if (!raw.startsWith("https://")) {
                ret.put("ok", false); ret.put("error", "not-https")
                call.resolve(ret); return
            }
            var bytes: ByteArray? = null
            var mime = "image/jpeg"
            var conn: java.net.HttpURLConnection? = null
            try {
                conn = java.net.URL(raw).openConnection() as java.net.HttpURLConnection
                conn.instanceFollowRedirects = true
                conn.connectTimeout = 15000
                conn.readTimeout = 30000
                conn.setRequestProperty("User-Agent", "NoteSyncApp")
                val code = conn.responseCode
                if (code in 200..299) {
                    val headerMime = conn.contentType ?: ""
                    if (headerMime.isNotBlank()) mime = headerMime
                    val max = 64L * 1024 * 1024
                    conn.inputStream.use { ins ->
                        val bos = java.io.ByteArrayOutputStream()
                        val buf = ByteArray(16 * 1024)
                        var n = ins.read(buf)
                        while (n > 0) {
                            if (bos.size().toLong() + n > max) throw IllegalStateException("too-large") // ByteArrayOutputStream.size 是方法非属性（CI 编译实锤）
                            bos.write(buf, 0, n); n = ins.read(buf)
                        }
                        bytes = bos.toByteArray()
                    }
                }
            } finally {
                try { conn?.disconnect() } catch (e: Exception) {}
            }
            val data = bytes
            if (data == null || data.isEmpty()) {
                ret.put("ok", false); ret.put("error", "download-failed")
                call.resolve(ret); return
            }
            // URL 扩展名优先于响应头（Cloudinary 有时回 octet-stream）
            val tail = raw.substringAfterLast('/', raw).substringBefore('?').toLowerCase()
            val ext = when {
                tail.endsWith(".png") -> "png"; tail.endsWith(".gif") -> "gif"
                tail.endsWith(".webp") -> "webp"; tail.endsWith(".jpg") || tail.endsWith(".jpeg") -> "jpg"
                mime.contains("png") -> "png"; mime.contains("gif") -> "gif"
                mime.contains("webp") -> "webp"; else -> "jpg"
            }
            val realMime = when (ext) { "png" -> "image/png"; "gif" -> "image/gif"; "webp" -> "image/webp"; else -> "image/jpeg" }
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            val name = "notesync-$stamp.$ext"
            val saved = if (Build.VERSION.SDK_INT >= 29) viaMediaStore(name, realMime, data)
                        else viaExternalFile(name, data)
            if (saved == null) {
                ret.put("ok", false); ret.put("error", "save-failed")
            } else {
                ret.put("ok", true); ret.put("path", saved); ret.put("bytes", data.size)
            }
        } catch (e: Exception) {
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }

    // API 29+：分区存储，落到公开的 Pictures/NoteSync，无需任何权限
    private fun viaMediaStore(name: String, mime: String, bytes: ByteArray): String? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/NoteSync")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
        // 写入必须整体兜底：流为 null 或写到一半抛异常，都要先删掉这一行，
        // 否则库里会留下一条 IS_PENDING=1 的孤儿记录——图库看不见、用户删不掉。
        try {
            val out = resolver.openOutputStream(uri) ?: throw IllegalStateException("openOutputStream null")
            out.use { it.write(bytes) }
        } catch (e: Exception) {
            try { resolver.delete(uri, null, null) } catch (ignored: Exception) {}
            throw e
        }
        values.clear(); values.put(MediaStore.Images.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return uri.toString()
    }

    // API 23–28：写应用外部目录再让扫描器收进图库，避开 WRITE_EXTERNAL_STORAGE
    private fun viaExternalFile(name: String, bytes: ByteArray): String? {
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_PICTURES), "NoteSync")
        if (!dir.exists() && !dir.mkdirs()) return null
        val f = File(dir, name)
        f.writeBytes(bytes)
        try {
            MediaScannerConnection.scanFile(context, arrayOf(f.absolutePath), arrayOf("image/*"), null)
            context.sendBroadcast(Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(f)))
        } catch (e: Exception) { /* 扫描失败不影响文件已落盘 */ }
        return f.absolutePath
    }
}
