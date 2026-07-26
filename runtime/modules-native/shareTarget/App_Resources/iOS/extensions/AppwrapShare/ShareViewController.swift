import UIKit
import MobileCoreServices

/// appwrap shareTarget — iOS share extension (`AppwrapShare` target, generated per-app by the CLI).
///
/// Collects the shared attachments (text / web URL / images), then delivers them one of two ways:
///
/// 1. DIRECT SYNC (opt-in via config `shareTarget.directSync`, stamped as `__SHARE_SYNC_B64__` —
///    base64 JSON, empty = off): the extension completes the share ITSELF with one HTTP call to the
///    app's backend, showing an honest "Syncing… → Synced" status in the drawer. `{key}` placeholders
///    in the URL / success-message templates resolve from the SHARE CONTEXT — a small JSON KV the
///    web app published via `kit.shareTarget.setContext(...)` (App Group UserDefaults key
///    `appwrap-share-context`). `merge:"append"` GETs the resource first, appends the shared text to
///    the existing text field (newline-joined) and preserves the existing image unless a new one is
///    shared. Any failure — offline, non-2xx, missing/unresolvable context, >1 image, oversized
///    image — falls back to (2). Apple forbids a share extension launching its host app; direct sync
///    makes launching unnecessary.
///
/// 2. MAILBOX (always available, the pre-direct-sync behavior): PERSIST the payload as a mailbox
///    entry in the shared App Group UserDefaults — the SAME deep-link contract Android uses:
///      __URL_SCHEME__://share?text=<enc>&title=<enc>&gfile=<enc>&gfile=<enc>…
///    - text / web URLs ride entirely in the URL (no files involved).
///    - images are written into the shared App Group container under `appwrap-share/`; each `gfile`
///      param is the file NAME there. The host shell relocates them into the app cache and rewrites
///      `gfile=` → `file=` (cache-relative) before the link reaches the web app — so the JS contract
///      is identical on both platforms (see runtime/app/shell/handlers-share-target.ts).
///    The host drains the mailbox (App Group key `appwrap-share-mailbox`, an appended string array)
///    on cold launch AND on every foreground/resume (read-once).
///
/// Build-time tokens (stamped by `appwrap init`/`sync`): __URL_SCHEME__ (config `urlScheme`),
/// __APP_GROUP__ (`group.<appId>`), __APP_NAME__ (Info.plist display name), __SHARE_SYNC_B64__
/// (config `shareTarget.directSync`, defaults applied — see appwrap-cli config.ts).
class ShareViewController: UIViewController {
    private var processed = false
    private var statusPill: UILabel?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !processed else { return }
        processed = true
        collectPayload { [weak self] texts, files in
            guard let self = self else { return }
            if texts.isEmpty && files.isEmpty {
                self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
                return
            }
            if let sync = self.directSyncPlan(texts: texts, files: files) {
                self.showStatus("Syncing…")
                self.runDirectSync(sync, texts: texts, files: files)
            } else {
                self.finishViaMailbox(texts: texts, files: files)
            }
        }
    }

    // MARK: payload collection

    /// Collect shared text/URLs (`texts`) and image file NAMES (`files`, already stashed into the
    /// App Group `appwrap-share/` dir — both delivery paths read them from there).
    private func collectPayload(_ done: @escaping ([String], [String]) -> Void) {
        var texts: [String] = []
        var files: [String] = []
        let group = DispatchGroup()
        // loadItem completions fire on provider-internal queues — serialize array mutation
        // (concurrent appends on a Swift Array are UB with multi-attachment shares).
        let collectQ = DispatchQueue(label: "appwrap.share.collect")

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier("public.url") && !provider.hasItemConformingToTypeIdentifier("public.file-url") {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: "public.url", options: nil) { data, _ in
                        collectQ.async {
                            if let u = data as? URL { texts.append(u.absoluteString) }
                            group.leave()
                        }
                    }
                } else if provider.hasItemConformingToTypeIdentifier("public.plain-text") {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: "public.plain-text", options: nil) { data, _ in
                        collectQ.async {
                            if let s = data as? String, !s.isEmpty { texts.append(s) }
                            else if let d = data as? Data, let s = String(data: d, encoding: .utf8), !s.isEmpty { texts.append(s) }
                            group.leave()
                        }
                    }
                } else if provider.hasItemConformingToTypeIdentifier("public.image") {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: "public.image", options: nil) { data, _ in
                        let name = self.stashImage(data) // heavy I/O stays off the serial queue
                        collectQ.async {
                            if let name { files.append(name) }
                            group.leave()
                        }
                    }
                }
            }
        }

        group.notify(queue: .main) { done(texts, files) }
    }

    /// Write a shared image (URL / Data / UIImage, whatever the provider hands over) into the App
    /// Group container `appwrap-share/` dir; returns the file name there, or nil on any failure
    /// (missing group entitlement included — text still goes through).
    private func stashImage(_ data: Any?) -> String? {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "__APP_GROUP__") else { return nil }
        let dir = root.appendingPathComponent("appwrap-share", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        do {
            if let src = data as? URL {
                let name = "\(stamp)-\(src.lastPathComponent.replacingOccurrences(of: "[^\\w.-]", with: "_", options: .regularExpression))"
                try FileManager.default.copyItem(at: src, to: dir.appendingPathComponent(name))
                return name
            }
            if let d = data as? Data {
                let name = "\(stamp)-shared.img"
                try d.write(to: dir.appendingPathComponent(name))
                return name
            }
            if let img = data as? UIImage, let d = img.pngData() {
                let name = "\(stamp)-shared.png"
                try d.write(to: dir.appendingPathComponent(name))
                return name
            }
        } catch { return nil }
        return nil
    }

    private func groupFileURL(_ name: String) -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "__APP_GROUP__")?
            .appendingPathComponent("appwrap-share", isDirectory: true).appendingPathComponent(name)
    }

    // MARK: direct sync (config `shareTarget.directSync` — stamped, empty token = off)

    private struct SyncPlan {
        let url: URL
        let method: String
        let textField: String
        let imageField: String
        let append: Bool
        let imageDataURL: String?  // nil = no image shared
        let imageFile: String?     // stashed name, deleted after a successful sync
        let successText: String
    }

    /// Decide whether THIS share can direct-sync: config stamped, context published, url template
    /// fully resolved, ≤1 image, image under the size cap. nil → mailbox path.
    private func directSyncPlan(texts: [String], files: [String]) -> SyncPlan? {
        let b64 = "__SHARE_SYNC_B64__"
        guard !b64.isEmpty,
              let cfgData = Data(base64Encoded: b64),
              let cfg = (try? JSONSerialization.jsonObject(with: cfgData)) as? [String: Any],
              let urlTemplate = cfg["urlTemplate"] as? String,
              let ctx = shareContext(),
              let urlStr = resolveTemplate(urlTemplate, ctx), let url = URL(string: urlStr)
        else { return nil }
        guard files.count <= 1 else { return nil } // multi-image shares keep full fidelity via the mailbox

        let fields = cfg["fields"] as? [String: Any]
        let maxImageBytes = (cfg["maxImageBytes"] as? Int) ?? 4_000_000
        var imageDataURL: String? = nil
        if let name = files.first {
            guard let fileURL = groupFileURL(name), let data = try? Data(contentsOf: fileURL) else { return nil }
            var encoded = "data:\(sniffMime(data));base64,\(data.base64EncodedString())"
            if encoded.utf8.count > maxImageBytes {
                // Typical camera photos exceed the cap — mirror the web app's pipeline: downscale
                // (longest edge → maxImageEdge, JPEG jpegQuality) before giving up. Only a still-over
                // (or undecodable) image sends the share down the mailbox, which keeps the ORIGINAL
                // bytes (the app downscales on drain, unchanged).
                let edge = CGFloat((cfg["maxImageEdge"] as? Double) ?? 2000)
                let quality = CGFloat((cfg["jpegQuality"] as? Double) ?? 0.85)
                guard let small = downscaled(data, maxEdge: edge, quality: quality) else { return nil }
                encoded = "data:image/jpeg;base64,\(small.base64EncodedString())"
                guard encoded.utf8.count <= maxImageBytes else { return nil } // still oversized → mailbox
            }
            imageDataURL = encoded
        }
        let successTemplate = (cfg["successMessage"] as? String) ?? "Synced"
        return SyncPlan(
            url: url,
            method: (cfg["method"] as? String) ?? "PUT",
            textField: (fields?["text"] as? String) ?? "content",
            imageField: (fields?["image"] as? String) ?? "image",
            append: (cfg["merge"] as? String) == "append",
            imageDataURL: imageDataURL,
            imageFile: files.first,
            successText: resolveTemplate(successTemplate, ctx) ?? "Synced"
        )
    }

    /// The app-published share context (App Group key `appwrap-share-context`, JSON KV). Numbers are
    /// stringified so templates can interpolate them.
    private func shareContext() -> [String: String]? {
        guard let d = UserDefaults(suiteName: "__APP_GROUP__"),
              let raw = d.string(forKey: "appwrap-share-context"),
              let obj = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any]
        else { return nil }
        var out: [String: String] = [:]
        for (k, v) in obj { out[k] = "\(v)" }
        return out
    }

    /// Replace `{key}` placeholders from the context. nil when any placeholder stays unresolved —
    /// a partially-resolved URL must never be called.
    private func resolveTemplate(_ template: String, _ ctx: [String: String]) -> String? {
        var s = template
        for (k, v) in ctx { s = s.replacingOccurrences(of: "{\(k)}", with: v) }
        return s.range(of: #"\{[^}]+\}"#, options: .regularExpression) == nil ? s : nil
    }

    /// Re-render an oversized image to `maxEdge` px longest edge, JPEG at `quality`. nil on decode
    /// failure (e.g. non-image bytes) — the caller falls back to the mailbox.
    private func downscaled(_ data: Data, maxEdge: CGFloat, quality: CGFloat) -> Data? {
        guard let img = UIImage(data: data), img.size.width > 0, img.size.height > 0 else { return nil }
        let w = img.size.width * img.scale, h = img.size.height * img.scale
        let scale = min(1, maxEdge / max(w, h))
        let size = CGSize(width: max(1, floor(w * scale)), height: max(1, floor(h * scale)))
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1
        let out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in
            img.draw(in: CGRect(origin: .zero, size: size))
        }
        return out.jpegData(compressionQuality: quality)
    }

    private func sniffMime(_ d: Data) -> String {
        if d.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if d.starts(with: [0xFF, 0xD8]) { return "image/jpeg" }
        if d.starts(with: [0x47, 0x49, 0x46]) { return "image/gif" }
        if d.count > 11, d[8...11].elementsEqual([0x57, 0x45, 0x42, 0x50]) { return "image/webp" }
        return "image/jpeg" // best-effort default (e.g. HEIC handed over re-encoded)
    }

    /// Execute the sync: (append mode) GET current → merge → write; else write as-is. Any failure
    /// falls back to the mailbox — the share is never lost.
    private func runDirectSync(_ plan: SyncPlan, texts: [String], files: [String]) {
        let fallback: () -> Void = { [weak self] in self?.finishViaMailbox(texts: texts, files: files) }
        let newText = texts.joined(separator: "\n")

        let write: ([String: Any]) -> Void = { [weak self] existing in
            guard let self = self else { return }
            let oldText = (existing[plan.textField] as? String) ?? ""
            let merged = plan.append && !oldText.isEmpty && !newText.isEmpty ? "\(oldText)\n\(newText)"
                : (newText.isEmpty ? oldText : newText)
            var body: [String: Any] = [plan.textField: merged]
            // New image replaces; append mode preserves the existing one (the endpoint is a full PUT).
            if let img = plan.imageDataURL { body[plan.imageField] = img }
            else if plan.append, let old = existing[plan.imageField] { body[plan.imageField] = old }
            else { body[plan.imageField] = NSNull() }
            var req = URLRequest(url: plan.url, timeoutInterval: 15)
            req.httpMethod = plan.method
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                DispatchQueue.main.async {
                    guard let code = (resp as? HTTPURLResponse)?.statusCode, (200..<300).contains(code) else { fallback(); return }
                    if let name = plan.imageFile, let u = self.groupFileURL(name) { try? FileManager.default.removeItem(at: u) }
                    self.finish(status: "✓ \(plan.successText)")
                }
            }.resume()
        }

        if plan.append {
            var req = URLRequest(url: plan.url, timeoutInterval: 15)
            req.httpMethod = "GET"
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                DispatchQueue.main.async {
                    guard let code = (resp as? HTTPURLResponse)?.statusCode else { fallback(); return } // offline
                    if code == 404 { write([:]); return } // nothing there yet — first write
                    guard (200..<300).contains(code) else { fallback(); return }
                    let existing = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
                    write(existing)
                }
            }.resume()
        } else {
            write([:])
        }
    }

    // MARK: host-app hand-off (App-Group mailbox)

    private func finishViaMailbox(texts: [String], files: [String]) {
        var params: [String] = []
        let enc = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
        if !texts.isEmpty { params.append("text=" + enc(texts.joined(separator: "\n"))) }
        for f in files { params.append("gfile=" + enc(f)) }
        enqueueMailbox("__URL_SCHEME__://share?" + params.joined(separator: "&"))
        finish(status: "Added to __APP_NAME__")
    }

    /// Durably append the share URL to the App Group mailbox. The host app drains this key
    /// (read-once) on cold launch and on every foreground — see handlers-share-target.ts.
    private func enqueueMailbox(_ url: String) {
        guard let d = UserDefaults(suiteName: "__APP_GROUP__") else { return }
        var box = d.stringArray(forKey: "appwrap-share-mailbox") ?? []
        box.append(url)
        d.set(box, forKey: "appwrap-share-mailbox")
        d.synchronize() // the extension process dies moments later — force the write to disk
    }

    /// Show the final status, let it register visually, then complete the request.
    private func finish(status: String) {
        showStatus(status)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }

    // MARK: drawer status pill

    /// Centered status pill ("Syncing…" / "✓ Synced…" / "Added to <AppName>") so the share never
    /// feels like a silent dismiss — the host app is NOT launched (iOS forbids that from a share
    /// extension). Reused across status changes.
    private func showStatus(_ text: String) {
        if let pill = statusPill { pill.text = "  \(text)  "; return }
        let pill = UILabel()
        pill.text = "  \(text)  "
        pill.font = UIFont.preferredFont(forTextStyle: .subheadline)
        pill.textColor = .white
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        pill.layer.cornerRadius = 18
        pill.clipsToBounds = true
        pill.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(pill)
        NSLayoutConstraint.activate([
            pill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pill.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            pill.heightAnchor.constraint(equalToConstant: 36),
        ])
        pill.alpha = 0
        UIView.animate(withDuration: 0.15) { pill.alpha = 1 }
        statusPill = pill
    }
}
