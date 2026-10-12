package cn.xuyinji.bj.diag

import android.content.ContentValues
import android.content.Intent
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// v3.1.4：诊断日志「导出 .txt」原生桥。
// 为什么必须走原生（与 ImgSavePlugin 同一条实锤）：壳内 `<a download>` 是哑弹
//（v8.0.8 导出图片链路已实锤，MainActivity:167 注释留档）——v3.1.3 的 Blob 下载
// 降级在 App 壳里静默无效，用户点「导出日志文件」没反应；WebView 里
// navigator.share 也不可用（Web Share API 是 Chrome 特性，WebView 不实现）。
// 落点：公开的 Download/NoteSync 目录——文件管理器直接可见，微信「文件」/
// USB 数据线传电脑都从这里拿。
// 零新权限（与 ImgSave 同款设计）：
//   · API 29+ → MediaStore.Downloads 带 RELATIVE_PATH=Download/NoteSync，分区存储免权限；
//   · API 23–28 → 写 getExternalFilesDir(Documents)/NoteSync 后发 MediaScanner 广播。
// 与 ImgSave / RemPlugin 同套路：显式 registerPlugin，JS 每次现读
// Capacitor.Plugins.DiagExport，失败把 error 传回 JS 由 JS 决定降级。
@CapacitorPlugin(name = "DiagExport")
class DiagExportPlugin : Plugin() {

    @PluginMethod
    fun saveText(call: PluginCall) {
        val ret = JSObject()
        try {
            val content = call.getString("content") ?: ""
            if (content.isEmpty()) {
                ret.put("ok", false); ret.put("error", "empty")
                call.resolve(ret); return
            }
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            val name = call.getString("name") ?: "notesync-diag-$stamp.txt"
            val bytes = content.toByteArray(Charsets.UTF_8)
            val saved = if (Build.VERSION.SDK_INT >= 29) viaMediaStore(name, bytes)
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

    // API 29+：分区存储，落公开 Download/NoteSync，无需任何权限
    private fun viaMediaStore(name: String, bytes: ByteArray): String? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/NoteSync")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
        // 写入必须整体兜底：流为 null 或写一半抛异常都要先删行，
        // 否则库里留下 IS_PENDING=1 的孤儿记录——文件管理器看不见、用户删不掉。
        try {
            val out = resolver.openOutputStream(uri) ?: throw IllegalStateException("openOutputStream null")
            out.use { it.write(bytes) }
        } catch (e: Exception) {
            try { resolver.delete(uri, null, null) } catch (ignored: Exception) {}
            throw e
        }
        values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return uri.toString()
    }

    // API 23–28：写应用外部目录再广播扫描器，避开 WRITE_EXTERNAL_STORAGE
    private fun viaExternalFile(name: String, bytes: ByteArray): String? {
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "NoteSync")
        if (!dir.exists() && !dir.mkdirs()) return null
        val f = File(dir, name)
        f.writeBytes(bytes)
        try {
            MediaScannerConnection.scanFile(context, arrayOf(f.absolutePath), arrayOf("text/plain"), null)
            context.sendBroadcast(Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.parse("file://" + f.absolutePath)))
        } catch (e: Exception) { /* 扫描失败不影响文件已落盘 */ }
        return f.absolutePath
    }
}
