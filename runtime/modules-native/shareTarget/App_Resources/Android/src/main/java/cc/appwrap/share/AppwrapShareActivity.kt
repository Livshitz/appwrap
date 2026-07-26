package cc.appwrap.share

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * appwrap shareTarget — Android lightweight share handler (generated per-app by the CLI, active only
 * when the `shareTarget` module is on). Declared translucent + no-history in the manifest (see the
 * module's `manifestApplication` XML), so tapping the app in the share sheet does NOT launch the full
 * app/WebView — this activity handles the SEND intent invisibly, exactly like the iOS share
 * extension handles the drawer:
 *
 * 1. DIRECT SYNC (config `shareTarget.directSync`, stamped as `__SHARE_SYNC_B64__` — base64 JSON,
 *    empty = off): one HTTP call to the app's backend with a "Syncing… → ✓ <successMessage>" toast.
 *    `{key}` placeholders resolve from the SHARE CONTEXT the web app published via
 *    `kit.shareTarget.setContext(...)` (SharedPreferences `appwrap-share` / key `context` — the
 *    Android sibling of iOS's App-Group `appwrap-share-context`). `merge:"append"` GETs first,
 *    appends text (newline-joined) and preserves the existing image unless a new one is shared.
 *    Oversized images are downscaled (longest edge → maxImageEdge, JPEG jpegQuality) first.
 *
 * 2. FALLBACK (any failure: offline, non-2xx, no/unresolved context, >1 image, still-oversized
 *    image): launch the main activity with the SAME deep link Android shares always used —
 *    `<urlScheme>://share?text=…&file=<cache-relative>…` — so the share is never lost and the JS
 *    contract is unchanged (see runtime/app/shell/handlers-share-target.ts).
 *
 * Build-time tokens (stamped by `appwrap init`/`sync`): __URL_SCHEME__, __SHARE_SYNC_B64__.
 */
class AppwrapShareActivity : Activity() {
    private val syncB64 = "__SHARE_SYNC_B64__"
    private val urlScheme = "__URL_SCHEME__"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            handleShare()
        } catch (e: Exception) {
            android.util.Log.w("AppwrapShare", "share handling failed", e)
            finish()
        }
    }

    private fun handleShare() {
        val action = intent?.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) { finish(); return }
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
        val title = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""
        val uris = streamUris(action)
        if (text.isEmpty() && uris.isEmpty()) { finish(); return }

        val plan = directSyncPlan(text, uris)
        if (plan == null) {
            android.util.Log.i("AppwrapShare", "direct sync unavailable (no config/context/resolvable url or multi-image) — falling back to app launch")
            fallbackToApp(text, title, uris); return
        }
        android.util.Log.i("AppwrapShare", "direct sync → ${plan.method} ${plan.url} (append=${plan.append}, image=${plan.imageDataUrl != null})")
        Toast.makeText(applicationContext, "Syncing…", Toast.LENGTH_SHORT).show()
        Thread {
            val ok = runDirectSync(plan)
            runOnUiThread {
                if (ok) {
                    Toast.makeText(applicationContext, "✓ ${plan.successText}", Toast.LENGTH_SHORT).show()
                    finish()
                } else {
                    fallbackToApp(text, title, uris) // never lose a share
                }
            }
        }.start()
    }

    private fun streamUris(action: String): List<Uri> = try {
        if (action == Intent.ACTION_SEND_MULTIPLE) {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.filterNotNull() ?: emptyList()
        } else {
            @Suppress("DEPRECATION")
            (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)?.let { listOf(it) } ?: emptyList()
        }
    } catch (e: Exception) {
        android.util.Log.w("AppwrapShare", "stream extras read failed", e)
        emptyList()
    }

    // ── direct sync ─────────────────────────────────────────────────────────

    private class SyncPlan(
        val url: String, val method: String, val textField: String, val imageField: String,
        val append: Boolean, val text: String, val imageDataUrl: String?, val successText: String,
    )

    /** Decide whether THIS share can direct-sync: config stamped, context published, url template
     * fully resolved, ≤1 image, image under the size cap (after downscale). null → fallback. */
    private fun directSyncPlan(text: String, uris: List<Uri>): SyncPlan? {
        if (syncB64.isEmpty()) return null
        if (uris.size > 1) return null // multi-image keeps full fidelity via the app
        val cfg = try { JSONObject(String(Base64.decode(syncB64, Base64.DEFAULT), Charsets.UTF_8)) }
            catch (e: Exception) { return null }
        val ctx = shareContext() ?: return null
        val url = resolveTemplate(cfg.optString("urlTemplate"), ctx) ?: return null
        if (!url.startsWith("http")) return null

        var imageDataUrl: String? = null
        if (uris.isNotEmpty()) {
            imageDataUrl = encodeImage(
                uris[0],
                cfg.optInt("maxImageBytes", 4_000_000),
                cfg.optInt("maxImageEdge", 2000),
                cfg.optDouble("jpegQuality", 0.85),
            ) ?: return null // undecodable / still oversized → fallback keeps the ORIGINAL bytes
        }
        val fields = cfg.optJSONObject("fields")
        return SyncPlan(
            url = url,
            method = cfg.optString("method", "PUT").ifEmpty { "PUT" },
            textField = fields?.optString("text").takeUnless { it.isNullOrEmpty() } ?: "content",
            imageField = fields?.optString("image").takeUnless { it.isNullOrEmpty() } ?: "image",
            append = cfg.optString("merge") == "append",
            text = text,
            imageDataUrl = imageDataUrl,
            successText = resolveTemplate(cfg.optString("successMessage").ifEmpty { "Synced" }, ctx) ?: "Synced",
        )
    }

    /** The app-published share context (SharedPreferences `appwrap-share`/`context`, JSON KV —
     * written by the shell's `shareTarget.setContext` handler). Values stringified for templates. */
    private fun shareContext(): Map<String, String>? = try {
        val raw = getSharedPreferences("appwrap-share", MODE_PRIVATE).getString("context", null) ?: return null
        val obj = JSONObject(raw)
        val out = mutableMapOf<String, String>()
        for (k in obj.keys()) out[k] = obj.get(k).toString()
        out
    } catch (e: Exception) { null }

    /** Replace `{key}` placeholders; null when any stays unresolved — a partially-resolved URL must
     * never be called. */
    private fun resolveTemplate(template: String, ctx: Map<String, String>): String? {
        if (template.isEmpty()) return null
        var s = template
        for ((k, v) in ctx) s = s.replace("{$k}", v)
        return if (Regex("\\{[^}]+\\}").containsMatchIn(s)) null else s
    }

    /** Shared image → base64 data URL under `maxBytes`; oversized inputs are downscaled (longest
     * edge → maxEdge px, JPEG at quality) via inSampleSize decode (no full-size bitmap → no OOM).
     * null on decode failure or still-over-cap. */
    private fun encodeImage(uri: Uri, maxBytes: Int, maxEdge: Int, quality: Double): String? {
        try {
            val raw = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
            val asIs = "data:${sniffMime(raw)};base64,${Base64.encodeToString(raw, Base64.NO_WRAP)}"
            if (asIs.length <= maxBytes) return asIs
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            val longest = maxOf(bounds.outWidth, bounds.outHeight)
            var sample = 1
            while (longest / (sample * 2) >= maxEdge) sample *= 2 // power-of-2 pre-scale keeps memory bounded
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            var bmp = BitmapFactory.decodeByteArray(raw, 0, raw.size, opts) ?: return null
            val edge = maxOf(bmp.width, bmp.height)
            if (edge > maxEdge) { // exact final scale (inSampleSize only gets within 2x)
                val scale = maxEdge.toFloat() / edge
                val scaled = Bitmap.createScaledBitmap(
                    bmp, maxOf(1, (bmp.width * scale).toInt()), maxOf(1, (bmp.height * scale).toInt()), true
                )
                if (scaled !== bmp) bmp.recycle()
                bmp = scaled
            }
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, (quality * 100).toInt().coerceIn(1, 100), out)
            bmp.recycle()
            val small = "data:image/jpeg;base64,${Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)}"
            return if (small.length <= maxBytes) small else null
        } catch (e: Exception) {
            android.util.Log.w("AppwrapShare", "image encode failed", e)
            return null
        }
    }

    private fun sniffMime(d: ByteArray): String = when {
        d.size > 3 && d[0] == 0x89.toByte() && d[1] == 0x50.toByte() -> "image/png"
        d.size > 1 && d[0] == 0xFF.toByte() && d[1] == 0xD8.toByte() -> "image/jpeg"
        d.size > 2 && d[0] == 0x47.toByte() && d[1] == 0x49.toByte() -> "image/gif"
        d.size > 11 && d[8] == 0x57.toByte() && d[9] == 0x45.toByte() -> "image/webp"
        else -> "image/jpeg"
    }

    /** Execute the sync on a background thread: (append) GET current → merge → write; else write
     * as-is. Mirrors ShareViewController.runDirectSync. Returns success. */
    private fun runDirectSync(plan: SyncPlan): Boolean = try {
        val existing: JSONObject = if (plan.append) {
            val (code, body) = http("GET", plan.url, null)
            android.util.Log.i("AppwrapShare", "direct sync merge GET → HTTP $code")
            when {
                code == 404 -> JSONObject() // nothing there yet — first write
                code in 200..299 -> try { JSONObject(body) } catch (e: Exception) { JSONObject() }
                else -> return false // offline / server error → fallback
            }
        } else JSONObject()

        val oldText = existing.optString(plan.textField)
        val merged = if (plan.append && oldText.isNotEmpty() && plan.text.isNotEmpty()) "$oldText\n${plan.text}"
            else plan.text.ifEmpty { oldText }
        val body = JSONObject().put(plan.textField, merged)
        // New image replaces; append mode preserves the existing one (the endpoint is a full PUT).
        when {
            plan.imageDataUrl != null -> body.put(plan.imageField, plan.imageDataUrl)
            plan.append && existing.has(plan.imageField) -> body.put(plan.imageField, existing.get(plan.imageField))
            else -> body.put(plan.imageField, JSONObject.NULL)
        }
        val (code, _) = http(plan.method, plan.url, body.toString())
        android.util.Log.i("AppwrapShare", "direct sync write → HTTP $code")
        code in 200..299
    } catch (e: Exception) {
        android.util.Log.w("AppwrapShare", "direct sync failed", e)
        false
    }

    private fun http(method: String, url: String, jsonBody: String?): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
            if (jsonBody != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(jsonBody.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return Pair(code, body)
        } finally {
            conn.disconnect()
        }
    }

    // ── fallback: hand the share to the full app via the existing deep-link path ──

    /** Launch the main activity with `<scheme>://share?…` (the pre-direct-sync contract): text/title
     * in the URL, streams copied into `<cacheDir>/appwrap-share/` as cache-relative `file=` params —
     * the same shape handlers-share-target.ts produced when the SEND filter sat on the main activity. */
    private fun fallbackToApp(text: String, title: String, uris: List<Uri>) {
        try {
            val params = mutableListOf<String>()
            if (text.isNotEmpty()) params.add("text=${Uri.encode(text)}")
            if (title.isNotEmpty()) params.add("title=${Uri.encode(title)}")
            for (rel in copyStreamsToCache(uris)) params.add("file=${Uri.encode(rel)}")
            if (params.isNotEmpty() && urlScheme.isNotEmpty()) {
                val open = Intent(Intent.ACTION_VIEW, Uri.parse("$urlScheme://share?${params.joinToString("&")}"))
                open.setPackage(packageName)
                open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                startActivity(open)
            }
        } catch (e: Exception) {
            android.util.Log.w("AppwrapShare", "fallback launch failed", e)
        }
        finish()
    }

    /** Copy each content:// stream into `<cacheDir>/appwrap-share/`; return cache-relative paths. */
    private fun copyStreamsToCache(uris: List<Uri>): List<String> {
        val out = mutableListOf<String>()
        if (uris.isEmpty()) return out
        val dir = File(cacheDir, "appwrap-share").apply { mkdirs() }
        uris.forEachIndexed { i, uri ->
            try {
                val name = fileNameFor(uri, i)
                contentResolver.openInputStream(uri)?.use { input ->
                    File(dir, name).outputStream().use { input.copyTo(it) }
                    out.add("appwrap-share/$name")
                }
            } catch (e: Exception) {
                android.util.Log.w("AppwrapShare", "stream copy failed", e)
            }
        }
        return out
    }

    /** Display name when the provider offers one, else mime-derived; sanitized + timestamp-prefixed
     * so repeated shares don't collide (mirrors handlers-share-target.ts fileNameFor). */
    private fun fileNameFor(uri: Uri, i: Int): String {
        var name = ""
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val idx = c.getColumnIndex("_display_name")
                if (idx >= 0 && c.moveToFirst()) name = c.getString(idx) ?: ""
            }
        } catch (e: Exception) { /* fall through to mime-derived name */ }
        if (name.isEmpty()) {
            val mime = contentResolver.getType(uri) ?: ""
            val ext = if (mime.startsWith("image/")) mime.substring(6).replace(Regex("[^a-zA-Z0-9]"), "").ifEmpty { "img" } else "bin"
            name = "shared-$i.$ext"
        }
        return "${System.currentTimeMillis()}-$i-${name.replace(Regex("[^\\w.-]"), "_")}"
    }
}
