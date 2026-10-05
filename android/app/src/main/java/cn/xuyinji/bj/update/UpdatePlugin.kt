package cn.xuyinji.bj.update

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.Settings
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

// v9.3.0：应用内升级原生桥（JS 侧 update.js 已在，只等这三个方法）。
// 为什么走 DownloadManager 而不是 HttpURLConnection 自拉流：
//   · APK 动辄几十 MB，系统下载器断点续传 + 网络调度白嫖，壳内自写循环纯属重造轮子；
//   · 落盘到 getExternalFilesDir(null)/update（应用私有外部目录），零存储权限，卸载即净。
// 与 ImgSave/Rem/LinkOpen 同套路：显式 registerPlugin，JS 每次现读 Capacitor.Plugins.AppUpdate，失败静默回退。
// 不加（也不能加）@NonBlocking：Capacitor 7 annotation 包没有该类，写了直接编译失败；
// 插件方法本就派发在专用后台线程（见 ImgSavePlugin 同款注释），enqueue/query 不占 UI。
// 全程只 resolve 不 reject：所有异常兜底成 {ok:false,error:...}，绝不让 JS 侧 catch 崩溃。
@CapacitorPlugin(name = "AppUpdate")
class UpdatePlugin : Plugin() {

    // 进程内内存映射，只为「同 url 重复调用先撤旧单」与「done 后回查绝对路径」服务，
    // 不持久化：进程重启后 downloadState 靠 COL_LOCAL_URI 兜底，install 靠 JS 回传的 path。
    private val urlToId = HashMap<String, Long>()
    private val idToPath = HashMap<Long, String>()

    /** downloadApk({url, tag}) → {ok, id, path} | {ok:false, error}
     *  tag 已含版本号，文件名 notesync-<tag>.apk 天然去重；非 https / 下载器不可用一律拒下。 */
    @PluginMethod
    fun downloadApk(call: PluginCall) {
        val ret = JSObject()
        try {
            val url = call.getString("url") ?: ""
            val wifiOnly = call.getBoolean("wifiOnly") ?: false // v9.3.6：后台预下载仅走 Wi-Fi，非 Wi-Fi 直接跳过不耗流量（getBoolean 单参返回可空，?:false 兜底）
            // v9.5.4：JS 从 /api/latest 的 asset.size 带下预期字节（APK ~26MB，Int 足够）。>0 时启用精确校验；
            // 0/未给＝兼容旧 JS，退回旧「>1MB 即复用」。坏/截断 APK 死循环复用是「packageInfo is null」根因。
            // 闸 R2-P0：Capacitor getInt 缺 key 返回可空 Integer，直接 takeIf 会拆箱 NPE 被外层 try 吞成 ok:false
            // ——旧 JS（离线缓存页）不传参时下载必坏；先 ?: 0 收敛再判定。
            val expectedBytes = (call.getInt("expectedBytes") ?: 0).coerceAtLeast(0).toLong()
            if (!url.startsWith("https://")) {
                // 明文 http 装 APK 等于把 root 递给中间人，闸都不进
                ret.put("ok", false); ret.put("error", "not-https")
                call.resolve(ret); return
            }
            val dm = try {
                context.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
            } catch (e: Exception) { null }
            if (dm == null) {
                ret.put("ok", false); ret.put("error", "no-download-manager")
                call.resolve(ret); return
            }
            val root = context.getExternalFilesDir(null)
            if (root == null) {
                ret.put("ok", false); ret.put("error", "no-external-dir")
                call.resolve(ret); return
            }
            val dir = File(root, "update")
            if (!dir.exists() && !dir.mkdirs()) {
                ret.put("ok", false); ret.put("error", "mkdir-failed")
                call.resolve(ret); return
            }
            // tag 消毒：只留文件名安全字符，防「../../」逃逸出 update/ 目录
            val rawTag = call.getString("tag") ?: ""
            val safeTag = rawTag.replace(Regex("[^A-Za-z0-9._-]"), "_")
                .ifEmpty { SimpleDateFormat("yyyyMMddHHmmss", Locale.US).format(Date()) }
            val f = File(dir, "notesync-$safeTag.apk")
            // v10.0.1 在跑单接管（「下载被取消了」根修）：同 url/同目标文件已有未完成下载单（预下载先发车、用户重复点、
            // 或进程重启后 urlToId 内存映射清零）——直接返回在跑单 id 让 JS 接着轮询。旧行为「撤旧单+删正在写的半成品+从零重下」
            // 让撞车的另一方立即 gone，删文件那一枪还会把没人撞的下载写成截断件（v9.5.4 尺寸闸兜住也只剩报 failed 重来）。
            findActiveTask(dm, url, f.absolutePath)?.let { activeId ->
                urlToId[url] = activeId
                idToPath[activeId] = f.absolutePath
                ret.put("ok", true); ret.put("attached", true); ret.put("id", activeId); ret.put("path", f.absolutePath)
                call.resolve(ret); return
            }
            // R2 闸 P1：同 url 重复调用不再「撤单+删文件+从零重下」——已下完的 APK 直接复用秒回（重进弹窗点更新不再是哑弹重跑）。
            // v9.5.4：带 expectedBytes 时精确相等才复用；大小不符＝截断/混装坏文件，删掉重下（旧「>1MB 即复用」会把坏文件永占缓存致 packageInfo is null 死循环）。
            if (f.exists()) {
                if (expectedBytes > 0L) {
                    if (f.length() == expectedBytes) {
                        ret.put("ok", true); ret.put("reused", true); ret.put("path", f.absolutePath); ret.put("bytes", f.length())
                        call.resolve(ret); return
                    }
                    try { f.delete() } catch (e: Exception) {} // 坏文件即删——上文在跑单接管已保证此刻绝没有写到一半的活单
                } else if (f.length() > 1_000_000L) {
                    ret.put("ok", true); ret.put("reused", true); ret.put("path", f.absolutePath); ret.put("bytes", f.length())
                    call.resolve(ret); return
                }
            }
            if (wifiOnly && !isOnWifi()) { // v9.3.6：仅 Wi-Fi 预下载——非 Wi-Fi 静默跳过，绝不偷跑蜂窝流量、也不留排队通知
                ret.put("ok", false); ret.put("wifi", false); ret.put("error", "not-wifi")
                call.resolve(ret); return
            }
            // v10.0.1：能走到这里＝无在跑单（findActiveTask 已接管）。撤的只会是终态旧单、删的只会是终态残件，再全新下载。
            urlToId[url]?.let { oldId ->
                try { dm.remove(oldId) } catch (e: Exception) { /* 旧任务已终态，撤不掉也不碍事 */ }
                if (f.exists()) try { f.delete() } catch (e: Exception) {}
            }
            val req = DownloadManager.Request(Uri.parse(url))
            req.setDestinationUri(Uri.fromFile(f))
            req.setAllowedNetworkTypes(
                if (wifiOnly) DownloadManager.Request.NETWORK_WIFI
                else DownloadManager.Request.NETWORK_WIFI or DownloadManager.Request.NETWORK_MOBILE)
            req.setVisibleInDownloadsUi(false)              // 不混进系统下载列表
            // v9.3.4：VISIBILITY_HIDDEN(=2) 是已废弃常量，setNotificationVisibility 只接受 0/1/3，传 2 会抛
            // 「Invalid value for visibility: 2」→ enqueue 前即崩、下载启动失败（用户 9.3.2 实测「立即更新」报错）。
            // 改合法的 VISIBILITY_VISIBLE：下载期间显示一条通知，进度仍由 JS 轮询，下完本插件自行拉安装器，不靠通知点击。
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            req.setMimeType("application/vnd.android.package-archive")
            val id = dm.enqueue(req)
            urlToId[url] = id
            idToPath[id] = f.absolutePath
            ret.put("ok", true); ret.put("id", id); ret.put("path", f.absolutePath)
        } catch (e: Exception) {
            // 部分 ROM 的 DownloadProvider 对 setDestinationUri 抛 SecurityException，一律兜底成 ok:false
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }

    /** 当前活动网络是否 Wi‑Fi（v9.3.6 仅 Wi‑Fi 预下载用）。取不到一律 false，宁可不预下也不偷跑蜂窝流量。 */
    private fun isOnWifi(): Boolean {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
            val net = cm.activeNetwork ?: return false
            val cap = cm.getNetworkCapabilities(net) ?: return false
            cap.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        } catch (e: Exception) { false }
    }

    // v10.0.1：本 App 是否有该 url/该落盘路径的未完成下载单（pending/running/paused），有则返回其 id。
    // 进程重启后 urlToId 内存映射清零，靠这里兜底找回在跑单：dm.query 不带 setFilterById 只回本应用自己的下载，
    // 无需 ACCESS_ALL_DOWNLOADS 权限。COLUMN_URI=远端 url，COLUMN_LOCAL_URI=落盘 file://（DownloadManager 自记）。
    // 查询抛异常按「无在跑单」处理——退回全新下载老路，最坏不过从零重下一趟，不会比旧版更坏。
    private fun findActiveTask(dm: DownloadManager, url: String, destPath: String): Long? {
        var cur: Cursor? = null
        try {
            cur = dm.query(DownloadManager.Query())
            val iId = cur.getColumnIndex(DownloadManager.COLUMN_ID)
            val iSt = cur.getColumnIndex(DownloadManager.COLUMN_STATUS)
            if (iId < 0 || iSt < 0) return null
            val iUrl = cur.getColumnIndex(DownloadManager.COLUMN_URI)
            val iLoc = cur.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
            while (cur.moveToNext()) {
                val st = cur.getInt(iSt)
                if (st != DownloadManager.STATUS_PENDING && st != DownloadManager.STATUS_RUNNING && st != DownloadManager.STATUS_PAUSED) continue
                val remote = if (iUrl >= 0) cur.getString(iUrl) else null
                if (remote == url) return cur.getLong(iId)
                val loc = if (iLoc >= 0) cur.getString(iLoc) else null
                val locPath = if (loc != null && loc.startsWith("file://")) Uri.parse(loc).path else loc
                if (locPath != null && locPath == destPath) return cur.getLong(iId)
            }
        } catch (e: Exception) {
            /* 查询失败＝无在跑单，走全新下载 */
        } finally {
            try { cur?.close() } catch (e: Exception) {}
        }
        return null
    }

    /** downloadState({id}) → {ok, status:'pending'|'running'|'done'|'failed'|'gone', downloaded, total, path}
     *  done 必校验文件存在且 >1e6 字节：下载器偶发「状态成功但文件截断」的哑弹，不校验就是安装器报错。 */
    @PluginMethod
    fun downloadState(call: PluginCall) {
        val ret = JSObject()
        try {
            // JS 数字经桥可能落 Integer/Long/Double/String，统一收敛成 Long 再比对
            val idObj = call.data.opt("id")
            val id = when (idObj) {
                is Number -> idObj.toLong()
                is String -> idObj.toLongOrNull() ?: -1L
                else -> -1L
            }
            if (id < 0) {
                ret.put("ok", false); ret.put("error", "no-id")
                call.resolve(ret); return
            }
            val dm = try {
                context.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
            } catch (e: Exception) { null }
            if (dm == null) {
                ret.put("ok", false); ret.put("error", "no-download-manager")
                call.resolve(ret); return
            }
            var cur: Cursor? = null
            try {
                cur = dm.query(DownloadManager.Query().setFilterById(id))  // DownloadManager.query 吃 Query 过滤器；CONTENT_URI 拼法不存在（CI 编译实锤）
                if (cur == null || !cur.moveToFirst()) {
                    // 查无此单：被 remove/系统清理/进程换代后 DownloadManager 侧记录没了
                    ret.put("ok", true); ret.put("status", "gone")
                    idToPath[id]?.let { ret.put("path", it) }
                    call.resolve(ret); return
                }
                val status = cur.getInt(cur.getColumnIndex(DownloadManager.COLUMN_STATUS))
                val reason = cur.getInt(cur.getColumnIndex(DownloadManager.COLUMN_REASON))
                val downloaded = cur.getLong(cur.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                val total = cur.getLong(cur.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                val localUri = cur.getString(cur.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI))
                // 路径优先用入队时记下的绝对路径；进程重启后退回 COL_LOCAL_URI 解析 file://
                val path = idToPath[id]
                    ?: if (localUri != null && localUri.startsWith("file://")) localUri.substring(7) else localUri
                // 语义自定（Android 常量：PENDING=1/RUNNING=2/PAUSED=4/SUCCESSFUL=8/FAILED=16）：
                // PAUSED 多为等网络/等空间，对用户就是「还没好但没死」→ 归 pending；未知状态归 running。
                var st = when (status) {
                    DownloadManager.STATUS_PENDING -> "pending"
                    DownloadManager.STATUS_PAUSED -> "pending"
                    DownloadManager.STATUS_RUNNING -> "running"
                    DownloadManager.STATUS_FAILED -> "failed"
                    DownloadManager.STATUS_SUCCESSFUL -> "done"
                    else -> "running"
                }
                if (st == "done") {
                    val f = path?.let { File(it) }
                    // v9.5.4：total 已知（DownloadManager 报了 Content-Length）就精确比对——状态说成功但字节不足＝截断/混装哑弹，
                    // 删文件（防下轮 downloadApk 复用）并判 failed 走重试；total 未知退回旧「>1MB」粗判。
                    val sizeOk = if (total > 0) (f != null && f.exists() && f.length() == total)
                                 else (f != null && f.exists() && f.length() > 1_000_000L)
                    if (!sizeOk) {
                        st = "failed" // 截断哑弹：状态说成功，文件系统说了算
                        try { f?.delete() } catch (e: Exception) {}
                    }
                }
                ret.put("ok", true)
                ret.put("status", st)
                ret.put("downloaded", if (downloaded < 0) 0L else downloaded)
                ret.put("total", if (total < 0) 0L else total)
                if (path != null) ret.put("path", path)
                if (st == "failed") ret.put("error", "dm-reason-" + reason)
            } finally {
                try { cur?.close() } catch (e: Exception) {}
            }
        } catch (e: Exception) {
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }

    /** install({path}) → {ok:true} 已拉起系统安装器 | {ok:false, needPermission:true} 待授权 | {ok:false, error}
     *  Android O+ 无「安装未知应用」授权就直接拉安装器只会被静默吞掉，先把球踢回 JS 引导授权。 */
    @PluginMethod
    fun install(call: PluginCall) {
        val ret = JSObject()
        try {
            val path = call.getString("path") ?: ""
            val f = File(path)
            if (path.isEmpty() || !f.isFile()) {
                ret.put("ok", false); ret.put("error", "file-missing")
                call.resolve(ret); return
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (!context.packageManager.canRequestPackageInstalls()) {
                    ret.put("ok", false); ret.put("needPermission", true)
                    call.resolve(ret); return
                }
            }
            // FileProvider 换 content:// 授权：O+ 直接 file:// 拉安装器会抛 FileUriExposedException
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", f)
            val launch = Intent(Intent.ACTION_VIEW)
            launch.setDataAndType(uri, "application/vnd.android.package-archive")
            launch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(launch)
            ret.put("ok", true)
        } catch (e: Exception) {
            // 无安装器可解析 / ROM 拦 startActivity 等，全部收敛成 ok:false
            ret.put("ok", false)
            ret.put("error", e.message ?: e.javaClass.simpleName)
        }
        call.resolve(ret)
    }

    /** requestInstallPermission() → 恒 {ok:false}：跳的是系统设置页，结果无法回传，「已尽力」就是全部语义。
     *  JS 侧回来后自己再问一次 install()，用 needPermission 消失判断授权完成。 */
    @PluginMethod
    fun requestInstallPermission(call: PluginCall) {
        val ret = JSObject()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val launch = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.packageName))
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(launch)
            }
        } catch (e: Exception) {
            // 部分 ROM（老 MIUI/窄壳定制）根本没这页，ActivityNotFound 直接咽下，不弹 toast 不崩
        }
        ret.put("ok", false)
        call.resolve(ret)
    }
}
