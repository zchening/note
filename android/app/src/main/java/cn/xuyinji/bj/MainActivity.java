// 🔴 溯源：本文件与其余8 个原生源（img/ link/ rem/ update/）从老项目 cn.xuyinji.notesync
//   **移植**而来，只做了包名/域名/单域条件替换，业务逻辑未改。移植的理由：插件代码是**平台
//   适配层**（DownloadManager / FileProvider / AlarmManager 的用法），与产品形态无关；
//   重写只会把老项目用真机踩出来的坑（VISIBILITY_HIDDEN 已废弃常量、同 url 互撤单、
//   截断 APK 复用死循环）重新踩一遍。业务架构（真源/加密/同步/UI）全部重做，一行未抄。
//
// 🔴 下面注释里的 v5.x~v10.x 是**老项目的**版本号，标记"这段代码是哪一代引入的"，
//   在本仓库里查不到对应 tag。它们是改这段代码时的线索（改动背景、踩坑原因），
//   不是本项目的版本号 —— 本项目版本号唯一真源是仓库根package.json 的 version。
package cn.xuyinji.bj;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import cn.xuyinji.bj.rem.RemPlugin;
import cn.xuyinji.bj.img.ImgClipPlugin;
import cn.xuyinji.bj.img.ImgSavePlugin;
import cn.xuyinji.bj.link.LinkOpenPlugin;
import cn.xuyinji.bj.update.UpdatePlugin;

public class MainActivity extends BridgeActivity {

    private boolean pendingRemNotifyClick = false;
    private static final String MAIN_DOC_CACHE = "cached_index.html";
    private static final String MAIN_DOC_ETAG = "cached_index.etag"; // v9.5.5：条件请求用弱/强 ETag 存文（fetchMainDoc 304 链路）
    // v10.1.0 A：磁盘缓存「是不是本机安装包同版」不另存版本戳文件，直接读 HTML 自带的 const APP_VERSION
    // 字面判——零写入顺序坑，且服务器部署滞后把旧版 HTML 混进缓存时当场识破、下一轮核对自愈。
    // v9.5.4 启动自愈：①WebView 渲染进程被 MIUI 幻影进程查杀/系统冻结杀死后画布全白全黑不自复——
    // 零 onRenderProcessGone 处理是根因，进程内只允许一次 recreate 防重建循环；
    // ②后台超 10 分钟回前台主动 reload，兜「冻而未死」（JS 定时器停摆、keep-alive socket 半死）灰区。
    // 闸 R1/R2 双路命中：必须 static——recreate() 后新实例字段归零，实例旗标的「进程内一次」不成立，
    // 渲染进程慢性被杀会变成 recreate 死循环；static 才是真·进程级一次。
    private static boolean didRendererGoneRecreate = false;
    private long pausedAt = 0;
    // v9.5.5 首载 watchdog：Capacitor 在 super.onCreate 内就发起首载（早于 setWebViewClient），
    // 半死 socket 下首载绕过拦截器、无超时保护 → 全白很久。此标志随主文档 onPageFinished 置真；
    // 装完 client 后 postDelayed 探测，若首载迟迟不落地则 stopLoading+loadUrl 重走带超时的拦截器三级兜底。
    private volatile boolean mainFrameDone = false;

    // v9.5.6 启动页②：原生 A2 幕布（纸底+品牌环+字标+金细线+slogan），盖住 WebView 加载期。
    // v9.5.7 揭幕时机：页面落地≥250ms 且 系统闪屏退场(≈App 首帧)≥450ms 双条件才掀（slogan 必须被看见）；
    // 首帧回调没来（ROM 差异）则退化为 v9.5.6 时机不硬等；15s 硬超时与错误兜底页即掀不变。
    private View splashCurtain;
    private volatile boolean splashCurtainUp = false;
    private volatile long curtainPageDoneAt = 0L;
    private volatile long curtainSplashExitAt = 0L;
    private Runnable curtainDropPending;

    // v9.5.7：双条件调度揭幕——两个信号（页面落地/首帧退场）各自到达时都调它，取 max 重排；
    // 重排前撤旧帖（否则先到的短延时会把幕布提前掀掉）。页面未落地不调度（错误/15s 兜底管）。
    private void scheduleCurtainDrop() {
        if (!splashCurtainUp || isFinishing() || isDestroyed()) return;
        if (curtainPageDoneAt == 0) return;
        final long now = android.os.SystemClock.elapsedRealtime();
        long when = curtainPageDoneAt + 250;
        if (curtainSplashExitAt > 0) when = Math.max(when, curtainSplashExitAt + 450);
        android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());
        if (curtainDropPending != null) h.removeCallbacks(curtainDropPending);
        curtainDropPending = new Runnable() {
            @Override public void run() { curtainDropPending = null; dropSplashCurtain(); }
        };
        h.postDelayed(curtainDropPending, Math.max(0, when - now));
    }

    // v9.5.6：掀幕（幂等）——落地/失败/超时三方共用，淡出后必 remove，绝不吞异常卡启动链。
    // 仅可在主线程调用（三处调用点均已在主线程 Handler/WebView 回调上）。
    private void dropSplashCurtain() {
        if (!splashCurtainUp) return;
        splashCurtainUp = false;
        if (MainActivity.bootCurtainAt == 0) { // v10.1.0 D：本轮冷启用户真正看见页面的时刻
            MainActivity.bootCurtainAt = android.os.SystemClock.elapsedRealtime() - MainActivity.bootT0;
        }
        final View c = splashCurtain;
        splashCurtain = null;
        if (c == null) return;
        try {
            c.animate().alpha(0f).setDuration(300).withEndAction(new Runnable() {
                @Override public void run() {
                    try {
                        android.view.ViewGroup vg = (android.view.ViewGroup) c.getParent();
                        if (vg != null) vg.removeView(c);
                    } catch (Throwable ignored) { }
                }
            }).start();
        } catch (Throwable ignored) {
            try {
                android.view.ViewGroup vg = (android.view.ViewGroup) c.getParent();
                if (vg != null) vg.removeView(c);
            } catch (Throwable t) { }
        }
    }

    // v5.56：离线兜底诊断计数（JS 端 ?diag 经 RemPlugin.cacheInfo 只读——定位兜底断在哪一环）
    public static volatile int interceptCount = 0;
    public static volatile int fetchFailCount = 0;
    public static volatile int cacheHitCount = 0;
    public static volatile int assetHitCount = 0;

    // v10.1.0 D：冷启主文档链路埋点（?diag 只读，零行为影响）。时刻一律 = elapsedRealtime 相对
    // bootT0 的毫秒差，0 = 该环节未发生。改「装完第一次打开慢」这类问题全靠手感必自欺，留凭据。
    // 整组读数在每次 onCreate 与 bootT0 同刻归零（闸 R2-P1）——只重置基准不重置读数，recreate 后
    // ==0 幂等守卫永不更新，会把上一轮数字当本轮显示。
    public static volatile long bootT0 = 0;            // onCreate 入口
    public static volatile long bootServeAt = 0;       // 本轮冷启首次「拦截器吐出主文档」
    public static volatile long bootPageDoneAt = 0;    // 本轮首次 onPageFinished
    public static volatile long bootCurtainAt = 0;     // 本轮掀幕
    public static volatile long bootBgRefreshMs = 0;   // 最近一次后台核对耗时（完成时写）
    public static volatile String mainDocSrc = "none"; // 最近一次主文档来源：disk | asset | net | none
    public static volatile int mainDocBytes = 0;       // 本轮冷启首次供给的字节数
    public static volatile String bgRefreshResult = "none"; // 304 | updated:NB | fail
    public static volatile int bootInterceptorReload = 0; // B：本轮掐掉绕过拦截器首载的次数（正常冷启恒 ≤1）
    public static volatile boolean cacheDiskIsCurrentVersion = false; // A：磁盘缓存自带版本号 不低于 安装包版本（可采用）
    private static volatile long lastBgRefreshAt = 0; // v10.1.0 A：后台核对 60s 冷却基准（elapsedRealtime）
    private static volatile boolean bgRefreshing = false; // 后台核对在途去重（static：recreate 后也不许再起一条）

    @Override
    public void onCreate(Bundle savedInstanceState) {
        bootT0 = android.os.SystemClock.elapsedRealtime(); // v10.1.0 D：冷启埋点基准
        // v10.1.0 闸 R2-P1 修：整组读数必须与基准同刻归零。只重置 bootT0 不重置读数，recreate
        // （v9.5.4 渲染进程自愈路径，恰是最需要看埋点的 MIUI 机型）之后 ==0 幂等守卫永远不再写入，
        // ?diag 会把上一轮的 pageDone/curtain 当作本轮毫秒显示——误导排障比没有埋点更糟。
        bootServeAt = 0;
        bootPageDoneAt = 0;
        bootCurtainAt = 0;
        bootBgRefreshMs = 0;
        mainDocBytes = 0;
        mainDocSrc = "none";
        bgRefreshResult = "none";
        bootInterceptorReload = 0;
        cacheDiskIsCurrentVersion = false;
        // v9.5.6 启动页①：正规启用系统 SplashScreen（纸底+带箭尖品牌环）承接冷启空窗。
        // 日夜按时间规则（<420 分或 >=1140 分=夜），与 JS shouldBeDark、下方 v9.5.5 WebView 表面
        // 预置块逐字同规则——本 App 夜不跟随系统，故 setTheme 显式选变体再 install（官方
        // setTheme-before-onCreate 模式，<31 由 androidx 读当前主题、31+ 平台首帧同认）。
        // 整块 try/catch：任何意外退回 manifest 基础主题（仍是纸底+环+日间色），绝不影响既有启动链。
        java.util.Calendar splashCal = java.util.Calendar.getInstance();
        int splashMin = splashCal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + splashCal.get(java.util.Calendar.MINUTE);
        final boolean splashNight = splashMin < 420 || splashMin >= 1140;
        try {
            setTheme(splashNight ? R.style.AppTheme_NoActionBarLaunch_Night : R.style.AppTheme_NoActionBarLaunch_Day);
            androidx.core.splashscreen.SplashScreen.installSplashScreen(this);
        } catch (Throwable ignored) { }
        // v5.51：注册自定义提醒桥（Capacitor 7 也支持自动扫描，显式注册更稳）
        registerPlugin(RemPlugin.class);
        registerPlugin(ImgClipPlugin.class); // v7.7.0：图片写系统剪贴板原生桥
        registerPlugin(ImgSavePlugin.class); // v9.2.0：正文图片保存到相册原生桥（零新权限，壳内 a[download] 是哑弹）
        registerPlugin(LinkOpenPlugin.class); // v8.1.0：链接打开方式（外跳默认浏览器/应用内子 WebView）
        registerPlugin(UpdatePlugin.class); // v9.3.0：应用内升级原生桥（DownloadManager 下 APK + FileProvider 拉安装）
        super.onCreate(savedInstanceState);

        // v5.53：返回键接 WebView 历史——Capacitor 不接管返回键，默认 finish 直接回桌面。
        // 笔记页按返回 → 回首页（自动跳转时 assign 留下的历史）；首页再按 → 退出。
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = (bridge != null) ? bridge.getWebView() : null;
                if (wv != null && wv.canGoBack()) {
                    wv.goBack();
                } else {
                    finish();
                }
            }
        });

        // 离线兜底页：断网/服务器不可达时 WebView 白屏，显示重试界面
        if (bridge == null) return;
        WebView wv = bridge.getWebView();
        if (wv == null) return;

        // v9.3.8：关闭 WebView 强制/算法深色——国产 ROM「浅色检测型反色」会把图片查看器里的浅色按钮
        // （保存到相册）单独翻色，导致浅底配浅字/黑底配黑字看不清。关掉后 WebView 按作者 CSS 原样渲染，
        // App 自带日夜由 JS 的 body.dark 管，系统强制深色不再作用于本 App。整段 try/catch(Throwable)：
        // 缺类/缺 API 时静默降级，绝不崩启动。
        try {
            android.webkit.WebSettings ws = wv.getSettings();
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                androidx.webkit.WebSettingsCompat.setAlgorithmicDarkeningAllowed(ws, false);
            } else if (android.os.Build.VERSION.SDK_INT >= 29) {
                androidx.webkit.WebSettingsCompat.setForceDark(ws, androidx.webkit.WebSettingsCompat.FORCE_DARK_OFF);
            }
        } catch (Throwable ignored) { }

        ViewGroup parent = (ViewGroup) wv.getParent();
        if (parent == null) return;
        final View fallback = getLayoutInflater().inflate(R.layout.activity_offline, parent, false);
        parent.addView(fallback);
        fallback.setVisibility(View.GONE);
        fallback.findViewById(R.id.btn_retry).setOnClickListener(v -> {
            fallback.setVisibility(View.GONE);
            wv.reload();
        });

        // v9.5.7 启动页②：A2 原生幕布（重构，真机三坑见下）。环=满幅矢量 splash_logo_* 96dp，
        // 衬线字标 19sp+金细线 34dp+slogan 12sp 单列整体居中（色值同 THEME_PALETTE/DayNight 变体）。
        // 揭幕=页面落地≥250ms 且 首帧退场≥450ms 双条件（scheduleCurtainDrop），15s 硬超时兜底，
        // 错误兜底页即掀；构建失败 Log.w 不再静默。v9.5.8 起系统闪屏纯纸底（空图，甲案），品牌只幕布这一处。
        try {
            final float dens = getResources().getDisplayMetrics().density;
            android.widget.LinearLayout curtain = new android.widget.LinearLayout(this);
            curtain.setOrientation(android.widget.LinearLayout.VERTICAL);
            curtain.setGravity(android.view.Gravity.CENTER);
            curtain.setBackgroundColor(splashNight ? 0xFF0F0F11 : 0xFFFBFBF8);
            android.widget.ImageView ring = new android.widget.ImageView(this);
            ring.setImageResource(splashNight ? R.drawable.splash_logo_night : R.drawable.splash_logo_day);
            curtain.addView(ring, new android.widget.LinearLayout.LayoutParams(
                    (int)(96 * dens + 0.5f), (int)(96 * dens + 0.5f)));
            android.widget.TextView wm = new android.widget.TextView(this);
            wm.setText(R.string.app_name);
            wm.setTypeface(android.graphics.Typeface.SERIF);
            wm.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 19);
            wm.setLetterSpacing(0.14f);
            wm.setMaxLines(1);
            wm.setTextColor(splashNight ? 0xFFE9E8E3 : 0xFF1C1C1A);
            android.widget.LinearLayout.LayoutParams wlp = new android.widget.LinearLayout.LayoutParams(
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT);
            wlp.topMargin = (int)(18 * dens + 0.5f);
            curtain.addView(wm, wlp);
            View hair = new View(this);
            android.widget.LinearLayout.LayoutParams hlp = new android.widget.LinearLayout.LayoutParams(
                    (int)(34 * dens + 0.5f), Math.max(1, (int)(1 * dens + 0.5f)));
            hlp.topMargin = (int)(15 * dens + 0.5f);
            hair.setLayoutParams(hlp);
            hair.setBackgroundColor(splashNight ? 0x80D4B068 : 0x808F7126);
            curtain.addView(hair);
            android.widget.TextView sg = new android.widget.TextView(this);
            sg.setText(R.string.splash_slogan);
            sg.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
            sg.setLetterSpacing(0.30f);
            sg.setMaxLines(1);
            sg.setTextColor(splashNight ? 0xFF7A786F : 0xFF98958A);
            android.widget.LinearLayout.LayoutParams sgp = new android.widget.LinearLayout.LayoutParams(
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT);
            sgp.topMargin = (int)(13 * dens + 0.5f);
            curtain.addView(sg, sgp);
            // 显式 MATCH_PARENT：CoordinatorLayout 默认子参数=WRAP_CONTENT×WRAP_CONTENT+左上，
            // v9.5.6 裸 addView 真机塌成左上窄条（字标折成「NoteS」、金线/slogan 被裁）。
            parent.addView(curtain, new android.view.ViewGroup.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT));
            splashCurtain = curtain;
            splashCurtainUp = true;
            // App 首帧≈系统闪屏退场启动时刻：只记时间戳供双条件调度；
            // 禁用退场动画接管监听（31+ 上会接管并吞掉系统 radial-wipe 退场动画）。
            // 首帧探测用 ViewTreeObserver.OnPreDrawListener（自 API1 存在，首次绘制前恰发一次，
            // 自摘）——View.postFrameCallback 在 CI 的 android.jar 无此符号（24/31 版本口径文档打架），
            // 本机无 SDK 肉眼过两次皆红，CI 编译是终裁，换零悬念 API。
            final Runnable markSplashExit = new Runnable() {
                @Override public void run() {
                    curtainSplashExitAt = android.os.SystemClock.elapsedRealtime();
                    scheduleCurtainDrop();
                }
            };
            final View curtainDv = getWindow().getDecorView();
            curtainDv.getViewTreeObserver().addOnPreDrawListener(new android.view.ViewTreeObserver.OnPreDrawListener() {
                @Override public boolean onPreDraw() {
                    try { curtainDv.getViewTreeObserver().removeOnPreDrawListener(this); } catch (Throwable ignored) { }
                    markSplashExit.run();
                    return true;
                }
            });
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override public void run() { dropSplashCurtain(); }
            }, 15000);
        } catch (Throwable t) {
            android.util.Log.w("NoteSync", "splash curtain build failed", t);
        }

        wv.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // v5.55 离线 P0 修复：主文档 native 层缓存，替代不可靠的 WebView SW 兜底。
                // 现象（v5.52~5.54）：server.url 直连线上，断网时主文档加载失败 → onReceivedError
                // 盖上原生"网络连接失败"页 → JS 的 notesync_cache_* 离线缓存体系根本没机会跑。
                // 修法：联网时 native 自己 fetch 线上 HTML 并落盘；断网/失败时回本地缓存文件，
                // 页面照常打开，JS 照常跑（localStorage origin 不变），离线阅读生效。
                // 热更新不受影响：联网时永远先拿线上最新版。
                // v8.1.0 同源白名单：主文档缓存链路只许 App 自己的域走。
                //   新项目单域 bj.xuyinji.com.cn（老项目是 note/biji 双域同库，故移植时两条会变两条重复）。
                // 无白名单时「应用内打开外站」的整页 GET 也会被 fetchMainDoc+saveMainDoc 当笔记主页缓存——
                // 断网启动兜底页变成外站 HTML（离线 P0 级污染）。外站请求落 super 正常加载。
                // 🔴 新项目只有单域 bj.xuyinji.com.cn。移植后原双域条件会变成
                //   "bj".equals(h) || "bj".equals(h) —— 重复条件恒等价于单条，
                //   编译得过、行为也对，但它是"这里本该只有一条"的证据，留着必被后人当双域看。
                String host = request.getUrl().getHost();
                boolean appHost = "bj.xuyinji.com.cn".equals(host);
                if (appHost && request.isForMainFrame() && "GET".equalsIgnoreCase(request.getMethod())) {
                    interceptCount++;
                    // v10.1.0 A：主文档本地优先，治「装完第一次打开必等公网」+「点笔记再等一次公网」。
                    // 旧链路每次主文档导航都同步问一次公网（命中 304 也要一个来回），只有断网/失败才落到
                    // 磁盘缓存与 APK 内置壳；而覆盖安装那一刻磁盘缓存按自带版本号判定属上一版 → 首开只能全量重下，
                    // 且首载绕过了拦截器（见下方 v5.57/v10.1.0 B 段），同一版内容实际白下两遍。
                    // 新链路：本地有货（磁盘缓存版本命中，否则 APK 内置壳——cap sync 打入的正是发版当版，
                    // 与安装包同版本）当场吐字节，公网核对挪后台线程并带 60s 冷却，命中或取新只写盘，
                    // 供下一次冷启用。点笔记那跳从此不再卡在公网往返上。
                    // 代价（用户 2026-09-22 拍板接受）：不发 APK、只在服务器上直改 index.html 的「同版号热修」
                    // 晚一次打开生效；发版场景零损失（内置壳就是当版，且自带版本号与安装包不符的磁盘缓存绝不当本版吐出）。
                    byte[] local = localMainDoc();
                    if (local != null && local.length > 0) {
                        markBootBytes(local.length);
                        bgRefreshMainDoc(request.getUrl().toString());
                        return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(local));
                    }
                    // 本地彻底无货（内置壳缺失/读失败的极端形态）→ 沿用原同步三级：联网 → 磁盘 → 内置壳。
                    // v10.1.0 闸 R1-P2 注：A 段生效后这条链路几乎不可达（内置壳随 APK 打包必然在）；
                    // 其中「304 直吐磁盘缓存」一支更甚——新语义下 304 只说明 etag 配对，不再蕴含
                    // "磁盘缓存属本版"（判归属的是自带版本号），故它只作为兜底存在，不再是冷启主路。
                    mainDocSrc = "net";
                    try {
                        String[] etagOut = new String[1];
                        byte[] bytes = fetchMainDoc(request.getUrl().toString(), etagOut);
                        if (bytes != null && bytes.length == 0) {
                            byte[] fresh = readMainDoc();
                            if (fresh != null && fresh.length > 0) {
                                cacheHitCount++;
                                markBootBytes(fresh.length);
                                return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(fresh));
                            }
                        } else if (bytes != null && bytes.length > 0) {
                            saveMainDoc(bytes, etagOut[0]);
                            markBootBytes(bytes.length);
                            return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(bytes));
                        }
                    } catch (Exception ignored) { }
                    fetchFailCount++;
                    byte[] cached = readMainDoc();
                    if (cached != null && cached.length > 0) {
                        cacheHitCount++;
                        mainDocSrc = "disk";
                        markBootBytes(cached.length);
                        return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(cached));
                    }
                    // v5.56 三级兜底：磁盘缓存也没有（首装未联网/数据被清/旧版拦截器从未生效）→ 回 APK 内置壳。
                    // CI 构建时 cap sync 已把当版 index.html 打进 assets/public，壳必然存在；
                    // 壳起后 JS 的 notesync_cache_* 离线缓存接管正文，「网络连接失败」页近乎不可达。
                    byte[] asset = assetMainDocCached();
                    if (asset != null && asset.length > 0) {
                        assetHitCount++;
                        mainDocSrc = "asset";
                        markBootBytes(asset.length);
                        return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(asset));
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                // 走到这里 = 联网失败且本地也无缓存（仅首次安装从未联网过的极端场景）
                if (request.isForMainFrame()) {
                    fallback.setVisibility(View.VISIBLE);
                    // v9.5.6：兜底页与幕布平级——立刻掀幕，重试按钮绝不被压在幕布后
                    new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
                        @Override public void run() { MainActivity.this.dropSplashCurtain(); }
                    });
                }
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                mainFrameDone = false; // v9.5.5：每次导航开始复位，供首载 watchdog 判本轮是否落地
                super.onPageStarted(view, url, favicon);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                mainFrameDone = true;  // v9.5.5：主文档落地，watchdog 不再补重载
                // v10.1.0 D：只记本轮冷启的首次落地（之后点笔记的导航不覆写），掀幕/公网核对同基准
                if (MainActivity.bootPageDoneAt == 0) {
                    MainActivity.bootPageDoneAt = android.os.SystemClock.elapsedRealtime() - MainActivity.bootT0;
                }
                // v9.5.7：记页面落地时刻，交双条件调度器定掀幕点（落地+250 与 退场+450 取 max；
                // 匿名 client 内必须 MainActivity.this）
                curtainPageDoneAt = android.os.SystemClock.elapsedRealtime();
                MainActivity.this.scheduleCurtainDrop();
                super.onPageFinished(view, url);
            }

            // v9.5.4 启动自愈：MIUI 幻影进程查杀/系统冻结会杀掉 WebView 渲染进程，画布留全白/全黑死屏。
            // 不消费此回调＝某些版本按未处理直接杀整 App，处理了不重建也永远白屏。
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (!didRendererGoneRecreate) {
                    didRendererGoneRecreate = true;
                    try {
                        if (view != null) {
                            android.view.ViewParent vp = view.getParent();
                            if (vp instanceof ViewGroup) ((ViewGroup) vp).removeView(view);
                            view.destroy();
                        }
                    } catch (Throwable ignored) { }
                    try { recreate(); return true; } catch (Throwable ignored) { }
                }
                // v9.5.5：进程内已重建过一次仍再死（渲染进程被反复查杀的极端机型）→ 静默 finish 像闪退，补一条提示
                try { android.widget.Toast.makeText(MainActivity.this, "界面渲染异常，请重新打开", android.widget.Toast.LENGTH_LONG).show(); } catch (Throwable ignored) { }
                try { finish(); } catch (Throwable ignored) { }
                return true;
            }
        });

        // v10.1.0 B（取代 v5.57 的「无磁盘缓存才补一次 reload」）：Capacitor 在 super.onCreate 内
        // setWebViewClient 之后紧接 loadUrl（Bridge.loadWebView 同步跑完），上面装的 client 必然赶不上
        // 首载——首载一定绕过拦截器吃公网；而此刻磁盘缓存自带版本号属上一版（判不中本版），于是同一版内容白下两遍
        // （绕过的那一遍 + 进笔记走拦截器再问的那一遍，用户感知的「装完第一次打开特别慢」大头在此）。
        // 修法：本地必有货（磁盘版本命中 / APK 内置壳）就当场掐掉这次在途请求、重走拦截器——请求刚发出
        // 响应未回，stopLoading 几乎零浪费，首帧改由本地字节直供（A 段），公网核对挪后台写盘供下次冷启用。
        // 本地彻底无货时绝不掐：留给公网三级兜底 + 下面 6s watchdog。v5.57 治的是「缓存写不进」，
        // 本段同时把「重复下载」和「首帧等公网」一并收掉。进程内一次沿用 v5.57 口径（recreate 后允许再来，
        // 渲染进程被反复杀的极端场景已由 didRendererGoneRecreate 的 static 旗标封顶）。
        if (!didBootInterceptorReload && localMainDocAvailable()) {
            didBootInterceptorReload = true;
            bootInterceptorReload++;
            try {
                wv.stopLoading();
                String bootStart = (bridge != null) ? bridge.getAppUrl() : null;
                if (bootStart != null && bootStart.startsWith("http")) wv.loadUrl(bootStart);
                else wv.reload();
            } catch (Throwable ignored) { }
        }

        // v9.5.5 ⑩ WebView 表面背景预置：默认白底在夜间冷启首帧前露出白闪（windowBackground 管不到
        // WebView 自身表面）。按与 shouldBeDark/head boot 同一时间规则预置夜色，首帧起就是对的底色。
        try {
            java.util.Calendar bootCal = java.util.Calendar.getInstance();
            int bootMin = bootCal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + bootCal.get(java.util.Calendar.MINUTE);
            boolean bootNight = bootMin < 420 || bootMin >= 1140;
            wv.setBackgroundColor(bootNight ? 0xFF0F0F11 : 0xFFFBFBF8);
        } catch (Throwable ignored) { }

        // v9.5.5 ⑧ 首载 watchdog（「全白很久」根治）：Capacitor 首载在 super.onCreate 内发起，早于
        // setWebViewClient——绕过拦截器的 3+6s 超时与三级兜底，半死 socket 下 Chromium 自身无应用层
        // 读超时（分钟级）。6s 主文档仍未 onPageFinished → stopLoading+loadUrl 当前目标重走拦截器：
        // 联网 3+6s 封顶 → 磁盘缓存 → 内置壳，白屏总封顶从「无限」压到 ~15s 内必有页面。
        final WebView wvBoot = wv;
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override public void run() {
                if (mainFrameDone || wvBoot == null || isFinishing() || isDestroyed()) return;
                try {
                    String cur = wvBoot.getUrl();
                    wvBoot.stopLoading();
                    wvBoot.loadUrl(cur != null && cur.startsWith("http") ? cur : "https://bj.xuyinji.com.cn/");
                } catch (Throwable ignored) { }
            }
        }, 6000);

        // v6.0：冷启动也接住通知点击（进程被杀后点通知拉起 APP，intent 走 onCreate 不走 onNewIntent）
        // v6.3 P1 根治「点通知有时进错笔记」：此前首屏加载根页后，JS 的「自动进入上次笔记」
        // (NOTE_LAST_KEY→assign('/B')) 与原生 rem-notify-click→assign('/A') 两个 location.assign
        // 竞速，谁的导航后 commit 谁赢（取决于网络/缓存时序）——有时 A 有时 B。
        // 修法：带 ACTION_NOTIFY_CLICK 冷启时首屏 URL 直接定到 '/'+noteId，根页竞速彻底消失；
        // 热启动路径（onNewIntent→rem-notify-click 事件）保留不变。
        Intent cold = getIntent();
        if (cold != null && RemPlugin.ACTION_NOTIFY_CLICK.equals(cold.getAction())) {
            pendingRemNotifyClick = true;
            String nid = cold.getStringExtra("noteId");
            if (nid != null && nid.matches("[A-Za-z0-9_-]{1,64}") && bridge != null && bridge.getWebView() != null) {
                String base = bridge.getAppUrl();
                if (base != null && base.length() > 0 && !base.endsWith("/")) {
                    final String target = base + "/" + nid;
                    android.util.Log.d("NoteSync", "cold-start notify click -> direct load: " + target);
                    bridge.getWebView().post(() -> {
                        if (bridge.getWebView() != null) bridge.getWebView().loadUrl(target);
                    });
                }
            }
        }

        // App Links：assetlinks 校验通过后点 bj 域链接直达 APK —— intent 里的 URL
        // 必须转发给 WebView，否则「开了 App 却落错页」（根页/上次笔记）。冷启沿用防竞速范式
        // post 直载目标；热启（singleTop）走 onNewIntent。只认本域 https，其余不转发（钓鱼链接不进 App）。
        // 闸R1-P1（移植保留）：转发前 origin 归一到 App 自身域（server.url=bj）——
        // 若将来加了别的域并原样直载，WebView 换源后 localStorage 按 origin 隔离
        // （密钥/缓存/草稿全另一套）=「直达即锁屏」。path/query/fragment 原样保留，只换 scheme+authority。
        Intent link = getIntent();
        if (isAppLink(link)) {
            final String target = appLinkTarget(link.getData().toString());
            if (target != null && bridge != null && bridge.getWebView() != null) {
                android.util.Log.d("NoteSync", "cold-start app link -> direct load: " + target);
                bridge.getWebView().post(() -> {
                    if (bridge.getWebView() != null) bridge.getWebView().loadUrl(target);
                });
            }
        }
    }

    /** v8.1.0：App Links 目标 URL 的 host 归一到 getAppUrl() origin（闸R1-P1 跨源锁屏修） */
    private String appLinkTarget(String url) {
        try {
            android.net.Uri base = android.net.Uri.parse(bridge.getAppUrl());
            if (base.getHost() == null) return url; // 拿不到 origin 就原样放行（退化=旧行为）
            return android.net.Uri.parse(url).buildUpon()
                .scheme(base.getScheme()).authority(base.getAuthority())
                .build().toString();
        } catch (Exception e) {
            return url;
        }
    }

    /** 仅收 bj.xuyinji.com.cn 的 https ACTION_VIEW 链接（App Links 直达）。
     *  🔴 新项目单域，不收老项目的 note 域链接 —— 那是另一个 App 的事，
     *     收下会互相抢流量、且 assetlinks 不匹配导致系统直接不验证。 */
    private boolean isAppLink(Intent it) {
        if (it == null || !Intent.ACTION_VIEW.equals(it.getAction())) return false;
        android.net.Uri u = it.getData();
        if (u == null || !"https".equals(u.getScheme())) return false;
        return "bj.xuyinji.com.cn".equals(u.getHost());
    }

    /** v10.1.0 B（原 v5.57 didCacheBootstrapReload）：掐掉绕过拦截器的首载、重走拦截器，进程内只跑一次
     *  防循环；进程 recreate 后允许再来（那时本地缓存通常已就位，走的是本地读，不产生公网浪费）。 */
    private boolean didBootInterceptorReload = false;

    /** v10.1.0 A：本地主文档（跑在 WebView 拦截线程，不在主线程）。口径：
     *  ①磁盘缓存，且其 HTML 自带的 APP_VERSION **不低于**本机安装包 versionName → 吐磁盘；
     *  ②否则吐 APK 内置壳 assets/public/index.html——它与安装包同版（cap sync 打入发版当版），
     *  覆盖安装后的第一次冷启正是靠它做到零公网。
     *  命中计数沿用 v5.56 口径：磁盘→cacheHitCount、内置壳→assetHitCount，?diag 历史可比。 */
    private byte[] localMainDoc() {
        DiskSnap snap = diskMainDocSnapshot();
        if (snap.bytes != null && snap.bytes.length > 0 && nsVersionCmp(snap.ver, installedVersionName()) >= 0) {
            cacheHitCount++;
            mainDocSrc = "disk";
            cacheDiskIsCurrentVersion = true;
            return snap.bytes;
        }
        cacheDiskIsCurrentVersion = false;
        byte[] asset = assetMainDocCached();
        if (asset != null && asset.length > 0) {
            assetHitCount++;
            mainDocSrc = "asset";
            return asset;
        }
        mainDocSrc = "none";
        return null;
    }

    /** v10.1.0 闸 R2-P0 修：采用判据是「磁盘缓存自带版本号 不低于 安装包版本」，不是「相等」。
     *  要挡的只有"覆盖安装后磁盘还躺着上一版"（此时必须退回内置壳=新版）；
     *  要放的恰恰是"服务器已热更到更高版本号、但这一版没发 APK"——那是本项目历史主通道
     *  （v10.0.2~v10.0.4 全部是"纯网页层热更、OTA 即达"）。写成相等会让老 APK 永远停在装机包那份
     *  页面、且 ?diag 看着完全健康＝静默掐断更新通道，故评审定 P0。
     *  任一版本号不可解析（含 unknown/截断/标记漂移）→ 返回 -2 走安全侧：不采用磁盘，用内置壳。 */
    private static int nsVersionCmp(String a, String b) {
        int[] va = parseVersion(a), vb = parseVersion(b);
        if (va == null || vb == null) return -2;
        for (int i = 0; i < 3; i++) {
            if (va[i] != vb[i]) return va[i] > vb[i] ? 1 : -1;
        }
        return 0;
    }

    /** 三段式数字版本解析；非纯数字/段数异常一律 null（宁可退回内置壳也不猜） */
    private static int[] parseVersion(String v) {
        if (v == null) return null;
        String s = v.trim();
        if (s.isEmpty()) return null;
        String[] parts = s.split("\\.");
        if (parts.length < 1 || parts.length > 3) return null;
        int[] out = new int[3];
        for (int i = 0; i < parts.length; i++) {
            String p = parts[i];
            if (p.isEmpty() || p.length() > 6) return null;
            for (int j = 0; j < p.length(); j++) {
                char c = p.charAt(j);
                if (c < '0' || c > '9') return null;
            }
            out[i] = Integer.parseInt(p);
        }
        return out;
    }

    /* v10.1.0 闸 R2-P2 修（读盘放大）：每次主帧导航都重读 844KB 磁盘缓存 + 全量扫版本号，判不中还要
       再读一份内置壳——导航一次白烧十几毫秒还占两份大字节数组。内置壳在进程内不可变，读一次常驻；
       磁盘侧以 (长度, mtime) 为键复用，且**唯一写者就是本类 saveMainDoc**，写成功后就地同步缓存，
       不存在"缓存比文件新"的窗口。 */
    private static final Object DOC_LOCK = new Object();
    private static byte[] sAssetBytes = null;
    private static boolean sAssetTried = false;
    private static byte[] sDiskBytes = null;
    private static String sDiskVer = null;
    private static long sDiskLen = -1L, sDiskMtime = -1L;

    private byte[] assetMainDocCached() {
        synchronized (DOC_LOCK) {
            if (sAssetTried) return sAssetBytes;
        }
        byte[] b = readAssetMainDoc();
        synchronized (DOC_LOCK) {
            sAssetTried = true;
            sAssetBytes = b;
            return b;
        }
    }

    /** 磁盘缓存快照（字节 + 自带版本号成对返回）。v10.1.0 闸二审-P2 修：两者必须同一次锁内成对取，
     *  分两次取锁期间若有后台核对换盘，会出现「判据用新版号、吐旧版字节」的一次性错配。
     *  键 (长度,mtime) 未变即复用常驻字节；唯一写者 saveMainDoc 在锁内就地同步，不留"缓存比文件新"窗口。 */
    private static final class DiskSnap {
        final byte[] bytes;
        final String ver;
        DiskSnap(byte[] b, String v) { bytes = b; ver = v; }
    }

    private DiskSnap diskMainDocSnapshot() {
        long len = -1L, mt = -1L;
        try {
            java.io.File df = new java.io.File(getFilesDir(), MAIN_DOC_CACHE);
            if (df.isFile()) { len = df.length(); mt = df.lastModified(); }
        } catch (Throwable ignored) { }
        synchronized (DOC_LOCK) {
            if (len > 0 && sDiskBytes != null && sDiskLen == len && sDiskMtime == mt) {
                return new DiskSnap(sDiskBytes, sDiskVer);
            }
        }
        byte[] b = len > 0 ? readMainDoc() : null;
        String v = embeddedVersion(b);
        synchronized (DOC_LOCK) {
            sDiskBytes = b;
            sDiskVer = v;
            sDiskLen = len;
            sDiskMtime = mt;
            return new DiskSnap(b, v);
        }
    }

    /** 只记本轮冷启的第一次主文档供给（时刻 + 字节数）；点笔记的后续导航不覆写。
     *  与 mainDocSrc 的分工：src 是"最近一次由谁供"（随导航走，配合 intercept/cacheHit/assetHit 累计数
     *  看链路活跃度），serve/bytes 是"本轮冷启首次"（看首开快不快）。v10.1.0 闸 R2-P1 明确要求两者
     *  口径分开写清，不许混在一行 diag 里让人误读。 */
    private void markBootBytes(int n) {
        if (bootServeAt == 0) {
            bootServeAt = android.os.SystemClock.elapsedRealtime() - bootT0;
            mainDocBytes = n;
        }
    }

    /** v10.1.0 B：只判「本地大概率有货」，供 onCreate 决定要不要掐掉绕过拦截器的首载。刻意做轻——
     *  内置壳可读即够（CI 构建 cap sync 必打入 assets/public/index.html），磁盘缓存只看存不存在，
     *  绝不在主线程 onCreate 里读 843KB 再抠版本号（那活归拦截线程的 localMainDoc 干）。
     *  判宽了也无害：真没货时拦截器自会落回原同步三级链路。 */
    private boolean localMainDocAvailable() {
        if (new java.io.File(getFilesDir(), MAIN_DOC_CACHE).exists()) return true;
        try {
            java.io.InputStream in = getAssets().open("public/index.html");
            try { in.close(); } catch (Throwable ignored) { }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** v10.1.0 A：抠 HTML 里的 `const APP_VERSION = 'x.y.z'` 字面（全库唯一出现，三处壳同源）。
     *  直接在 ASCII 字节上扫，免得为 843KB 缓存再拷一份 String；找不到/超长/空 → null（判为不匹配，
     *  安全侧后果只是多用一次内置壳，秒开不受影响，绝不会把未知版本的磁盘缓存当本版吐出去）。 */
    private static String embeddedVersion(byte[] b) {
        if (b == null || b.length == 0) return null;
        try {
            final String marker = "const APP_VERSION = '";
            final int m = marker.length();
            outer:
            for (int i = 0; i + m < b.length; i++) {
                for (int j = 0; j < m; j++) {
                    if (b[i + j] != (byte) marker.charAt(j)) continue outer;
                }
                int s = i + m, e = s;
                while (e < b.length && e - s < 32 && b[e] != (byte) '\'') e++;
                if (e >= b.length || e == s || e - s >= 32) return null;
                return new String(b, s, e - s, "UTF-8");
            }
        } catch (Throwable ignored) { }
        return null;
    }

    /** v10.1.0 A：后台条件核对（复用 fetchMainDoc 的 If-None-Match/304 链路）。只写盘、绝不回填本轮响应
     *  ——本轮已经吐了本地文档，热更新语义由此变成「最迟晚一次打开」。60s 冷却 + 在途去重：点笔记也是
     *  主文档导航，无冷却会把公网核对打成连发线程。取到的新版供下一次冷启直读（版本不一致则继续用内置壳）。 */
    private void bgRefreshMainDoc(final String urlStr) {
        final long now = android.os.SystemClock.elapsedRealtime();
        if (bgRefreshing || now - lastBgRefreshAt < 60000) return;
        lastBgRefreshAt = now;
        bgRefreshing = true;
        try {
            new Thread(new Runnable() {
                @Override public void run() {
                    long t0 = android.os.SystemClock.elapsedRealtime();
                    try {
                        String[] etagOut = new String[1];
                        byte[] bytes = fetchMainDoc(urlStr, etagOut);
                        if (bytes == null) {
                            bgRefreshResult = "fail";
                        } else if (bytes.length == 0) {
                            bgRefreshResult = "304";
                        } else {
                            saveMainDoc(bytes, etagOut[0]);
                            bgRefreshResult = "updated:" + bytes.length + "B";
                        }
                    } catch (Throwable t) {
                        bgRefreshResult = "fail";
                    } finally { // v10.1.0 闸 R2-P2 修：在途旗标必须无条件收口，否则一次意外就让后台核对整进程熄火
                        bootBgRefreshMs = android.os.SystemClock.elapsedRealtime() - t0; // v10.1.0 D：核对耗时
                        bgRefreshing = false;
                    }
                }
            }, "ns-doc-refresh").start();
        } catch (Throwable t) { // 线程都起不来（极端内存压力）也不能把在途旗标永久压住
            bgRefreshing = false;
            bgRefreshResult = "fail";
        }
    }

    /** 当前安装包 versionName（读失败记 "unknown"，此后磁盘缓存永不判为本版 → 恒用内置壳，仍是秒开，不致回退公网） */
    private static volatile String cachedVersionName = null;
    private String installedVersionName() {
        String v = cachedVersionName;
        if (v != null) return v;
        String got = null;
        try { got = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Throwable ignored) { }
        cachedVersionName = (got == null || got.isEmpty()) ? "unknown" : got;
        return cachedVersionName;
    }

    /** 联网时 native 侧抓主文档；无网络直接返回 null 快败（不阻塞拦截层）。
     *  v9.5.5 闸修（R1/R2 P1：ETag 在 App 链路是死代码——拦截器自抓不带条件头，冷启仍全量 275KB）：
     *  有磁盘缓存且存过 ETag 时带 If-None-Match 条件请求；304 返回空数组（byte[0]）信号，调用方直接吐磁盘缓存。
     *  v10.1.0 闸 R1-P1 修：ETag **不再在这里落盘**——旧写法"响应头一到就写 etag，再开始流式读正文"，
     *  流到一半进程被杀就留下「新 etag + 旧 HTML」，此后条件请求恒 304 把旧页永久钉死（磁盘升为主供方后
     *  危害面被放大）。现由 etagOut[0] 把 etag 交回调用方，与正文一起进 saveMainDoc 配对提交。
     *  v10.1.0 闸二审-P2 修：不再用实例字段暂存 etag——拦截线程与后台核对线程可并发进入本方法，
     *  共享字段会被另一路覆盖/清空，导致「正文配错 etag」→ 服务端 304 后旧页同样被永久钉死。
     *  调用方必须自带 `String[] etagOut = new String[1]`，返回值与 etag 天然同批次。 */
    private byte[] fetchMainDoc(String urlStr, String[] etagOut) throws Exception {
        if (etagOut != null && etagOut.length > 0) etagOut[0] = null;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkInfo ni = cm.getActiveNetworkInfo();
        if (ni == null || !ni.isConnected()) return null;
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setConnectTimeout(3000);
        conn.setReadTimeout(6000);
        conn.setRequestProperty("Accept", "text/html");
        try {
            java.io.File df = new java.io.File(getFilesDir(), MAIN_DOC_CACHE);
            String savedEtag = readSmallText(MAIN_DOC_ETAG);
            if (df.exists() && savedEtag != null && !savedEtag.isEmpty()) conn.setRequestProperty("If-None-Match", savedEtag);
        } catch (Exception ignored) { }
        try {
            int code = conn.getResponseCode();
            if (code == 304) return new byte[0]; // 条件命中：磁盘缓存仍新鲜
            if (code < 200 || code >= 300) return null;
            try {
                String et = conn.getHeaderField("ETag");
                if (et != null && !et.isEmpty() && etagOut != null && etagOut.length > 0) etagOut[0] = et; // 只带回，不落盘
            } catch (Exception ignored) { }
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                return bo.toByteArray();
            }
        } finally {
            conn.disconnect();
        }
    }

    private String readSmallText(String name) {
        try (FileInputStream fi = openFileInput(name); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
            byte[] buf = new byte[512]; int n;
            while ((n = fi.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8").trim();
        } catch (Exception e) { return null; }
    }

    private void writeSmallText(String name, String val) {
        try (FileOutputStream fo = openFileOutput(name, MODE_PRIVATE)) {
            fo.write(val.getBytes("UTF-8"));
        } catch (Exception ignored) { }
    }

    /** 落盘主文档：写 .tmp + fsync + rename 覆盖 → **仅原子路径成功才**提交配对的 ETag → 最后同步读缓存。
     *  v10.1.0 闸 R1-P1-2/R2-P2-4 修：旧写法 openFileOutput 直接截断重写 844KB，流到一半进程被杀就留下
     *  半截 HTML；而 `const APP_VERSION` 在文件前部，半截页照样抠得到该版本号 → 残页被判作已装版本吐出、
     *  首轮白屏，且 etag 若已抢先落盘则后续恒 304 永不自愈（磁盘升为主供方后危害面放大）。
     *  v10.1.0 闸二审-P2 修两点：①rename 失败退回的直写路径**不提交 etag**——否则等于把刚杀死的
     *  「新 etag + 半截页 → 恒 304 钉死」从退路里复活；宁可下轮多下一次全量，也不配一对假的。
     *  ②整体挂 DOC_LOCK：拦截线程与后台核对线程可并发到达此处，同名 .tmp 互踩会写出交叉残件。
     *  @param etag 与本次 bytes 同一批响应带回的 ETag（null 表示不提交） */
    private void saveMainDoc(byte[] bytes, String etag) {
        if (bytes == null || bytes.length == 0) return;
        boolean atomicOk = false;
        boolean written = false;
        synchronized (DOC_LOCK) {
            java.io.File dst = new java.io.File(getFilesDir(), MAIN_DOC_CACHE);
            java.io.File tmp = new java.io.File(getFilesDir(), MAIN_DOC_CACHE + ".tmp");
            try {
                try (java.io.FileOutputStream fo = new java.io.FileOutputStream(tmp)) {
                    fo.write(bytes);
                    fo.flush();
                    try { fo.getFD().sync(); } catch (Throwable ignored) { }
                }
                atomicOk = tmp.renameTo(dst);
            } catch (Throwable ignored) { }
            if (!atomicOk) { // 极少数机型/瞬时占用：退回直写，保住"能落盘"，但因此不配 etag
                try (FileOutputStream fo = openFileOutput(MAIN_DOC_CACHE, MODE_PRIVATE)) {
                    fo.write(bytes);
                    written = true;
                } catch (Throwable ignored) { }
            } else {
                written = true;
            }
            try { if (tmp.exists()) tmp.delete(); } catch (Throwable ignored) { }
            if (!written) return; // 两种写法都没成，绝不提交 etag、绝不更新缓存
            if (atomicOk && etag != null && !etag.isEmpty()) {
                try { writeSmallText(MAIN_DOC_ETAG, etag); } catch (Throwable ignored) { }
            }
            long len = -1L, mt = -1L;
            try { if (dst.isFile()) { len = dst.length(); mt = dst.lastModified(); } } catch (Throwable ignored) { }
            sDiskBytes = bytes; // 本类是唯一写者：写成功即同步缓存，不留"缓存比文件新"窗口
            sDiskVer = embeddedVersion(bytes);
            sDiskLen = len;
            sDiskMtime = mt;
        }
    }

    private byte[] readMainDoc() {
        try (FileInputStream fi = openFileInput(MAIN_DOC_CACHE); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = fi.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    /** v5.56 末级兜底：APK 内置壳（assets/public/index.html，构建时 cap sync 打入当版） */
    private byte[] readAssetMainDoc() {
        try (InputStream in = getAssets().open("public/index.html"); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // v8.1.0 热启 App Links：singleTop 复用实例，新 intent 的 URL 直载 WebView（页内导航，
        // 脏保存由既有 pagehide→flushDirtySave 链兜底）；origin 归一同冷启（闸R1-P1）
        if (isAppLink(intent) && bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().loadUrl(appLinkTarget(intent.getData().toString()));
        }
        // 通知点击 → 通过事件通知 JS。
        // App 被杀后冷启时 WebView 尚未就绪，先缓存，待 onResume 补发。
        if (intent != null && RemPlugin.ACTION_NOTIFY_CLICK.equals(intent.getAction())) {
            if (bridge != null && bridge.getWebView() != null) {
                dispatchRemNotifyClick();
            } else {
                pendingRemNotifyClick = true;
            }
        }
    }

    // 必须是 public：BridgeActivity.onResume() 是 public，override 收窄为 protected 会编译失败
    @Override
    public void onResume() {
        super.onResume();
        // v5.55：前台标志——前台时 JS 提醒卡+声音已负责，RemReceiver 不重复推通知
        RemPlugin.isForeground = true;
        // v9.5.5 修正：v9.5.4 的无条件 reload 本身就是「黑屏闪几下→白加载中→黑加载中」的制造者
        // （躺 11 分钟回来必闪一整轮）。改为心跳探活：JS 每秒写 window.__nsBeat，取不到或落后 >15s
        // 才说明页面真「冻而未死」→ reload；活着就静默返回，一帧都不闪。
        if (pausedAt > 0 && System.currentTimeMillis() - pausedAt > 10 * 60_000L) {
            final WebView wvResume = (bridge != null) ? bridge.getWebView() : null;
            pausedAt = 0;
            if (wvResume != null) {
                try {
                    wvResume.evaluateJavascript("String(Date.now()-(window.__nsBeat||0))", new android.webkit.ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) {
                            long gap = Long.MAX_VALUE; // 取不到/非数字＝当死页处理
                            try { gap = Long.parseLong(String.valueOf(value).replace("\"", "")); } catch (Exception ignored) { }
                            if (gap > 15000) {
                                try { if (!isFinishing() && !isDestroyed()) { wvResume.stopLoading(); wvResume.reload(); } } catch (Throwable ignored) { }
                            }
                        }
                    });
                } catch (Throwable ignored) { }
            }
        }
        if (pendingRemNotifyClick) {
            dispatchRemNotifyClick();
        }
    }

    @Override
    public void onPause() { // BridgeActivity.onPause 是 public，override 不能降 visibility（同 onResume 教训）
        super.onPause();
        // v5.55：非前台（后台/被杀/冷启）一律推通知栏——正是用户要的语义
        RemPlugin.isForeground = false;
        pausedAt = System.currentTimeMillis(); // v9.5.4：onResume 陈旧守卫时间戳
    }

    private void dispatchRemNotifyClick() {
        if (bridge == null || bridge.getWebView() == null) return;
        pendingRemNotifyClick = false;
        // v6.0：带 noteId 派发——JS 收到后若不是当前笔记，直接跳到提醒所属的笔记
        Intent it = getIntent();
        String nid = (it != null) ? it.getStringExtra("noteId") : null;
        final String nidJson = (nid == null) ? "null" : org.json.JSONObject.quote(nid);
        bridge.getWebView().post(() -> {
            if (bridge.getWebView() != null) {
                // 等页面 JS 就绪（DOMContentLoaded/interactive）再派发，避免事件丢失
                bridge.getWebView().evaluateJavascript(
                    "(function(){var f=function(){window.dispatchEvent(new CustomEvent('rem-notify-click',{detail:{noteId:" + nidJson + "}}));};"
                        + "if(document.readyState==='complete'||document.readyState==='interactive'){f();}"
                        + "else{window.addEventListener('DOMContentLoaded',f);}})();",
                    null
                );
            }
        });
    }
}
