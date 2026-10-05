package cn.xuyinji.bj.link

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import cn.xuyinji.bj.R

// v8.1.0「应用内打开链接」子 WebView：独立 Activity 承载，主 WebView 的笔记编辑态/密钥零打扰。
// 刻意不装 MainActivity 的主文档拦截器——外站页面永不进离线兜底缓存（MainActivity 同源白名单是第二道保险）。
// 顶栏=‹ 返回 + 站点 host；返回键/返回钮先走网页历史再关页；非 http(s) 目标一律拒绝（防 intent:// 逃逸）。
class LinkViewActivity : AppCompatActivity() {

    private var wv: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_link_view)
        val url = intent.getStringExtra("url")
        val view = findViewById<WebView>(R.id.linkWv)
        wv = view
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val u = request?.url?.toString() ?: return false
                return !(u.startsWith("http://") || u.startsWith("https://"))
            }
            override fun onPageFinished(view: WebView?, url2: String?) {
                findViewById<TextView>(R.id.linkTitle).text = try { Uri.parse(view?.url ?: url2)?.host ?: "" } catch (e: Exception) { "" }
            }
        }
        findViewById<TextView>(R.id.linkBack).setOnClickListener {
            if (wv?.canGoBack() == true) wv?.goBack() else finish()
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (wv?.canGoBack() == true) wv?.goBack() else finish()
            }
        })
        if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) view.loadUrl(url)
    }

    override fun onDestroy() {
        wv?.destroy()
        wv = null
        super.onDestroy()
    }
}
