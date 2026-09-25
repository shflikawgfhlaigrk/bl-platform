import SwiftUI
import WebKit
import UIKit

@main
struct OneClubPOSApp: App {
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            RegisterRoot()
                .onChange(of: phase) { _, value in UIApplication.shared.isIdleTimerDisabled = value == .active }
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        }
    }
}

enum VenueAddress {
    static func parse(_ text: String) -> URL? {
        guard let u = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = u.host?.lowercased(), u.user == nil, u.password == nil,
              u.query == nil, u.fragment == nil, u.path.isEmpty || u.path == "/" else { return nil }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        let privateIP = parts.count == 4 && parts.allSatisfy { (0...255).contains($0) } &&
            (parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1])))
        let local = privateIP || host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".local")
        guard u.scheme == "https" || (u.scheme == "http" && local) else { return nil }
        var components = URLComponents(url: u, resolvingAgainstBaseURL: false)!
        components.path = ""; return components.url
    }
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        func port(_ u: URL) -> Int { u.port ?? (u.scheme == "https" ? 443 : 80) }
        return a.scheme == b.scheme && a.host == b.host && port(a) == port(b)
    }
}

struct RegisterRoot: View {
    @State private var showPrinter = false
    @State private var reloadID = UUID()
    @State private var loadError: String?
    private let navy = Color(red: 0.094, green: 0.094, blue: 0.27)
    var body: some View {
        ZStack {
            RegisterWebView(origin: URL(string: "barone://register")!, onError: { loadError = $0 }).id(reloadID)
            if let message = loadError {
                VStack(spacing: 18) {
                    Image(systemName: "ipad").font(.largeTitle)
                    Text("Open your register").font(.title2.bold())
                    Text(message).multilineTextAlignment(.center)
                    Button("Open again") { loadError = nil; reloadID = UUID() }.buttonStyle(.borderedProminent)
                }.padding(32).frame(maxWidth: 440).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack {
                Label("Bar One · Saved on this iPad", systemImage: "ipad")
                Spacer()
                Button("Receipt printer", systemImage: "printer") { showPrinter = true }
            }.font(.footnote).padding(.horizontal, 20).padding(.vertical, 8).foregroundStyle(.white).background(navy)
        }
        .tint(navy)
        .sheet(isPresented: $showPrinter) { StarReceiptPrinterView() }
    }
}

struct RegisterWebView: UIViewRepresentable {
    let origin: URL
    let onError: (String?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(origin: origin, onError: onError) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(LocalRegisterAssets(), forURLScheme: "barone")
        configuration.userContentController.addScriptMessageHandler(LocalRegisterStore.shared, contentWorld: .page, name: "barOneStore")
        configuration.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "oneClubPrint")
        configuration.userContentController.add(context.coordinator, name: "oneClubExport")
        configuration.userContentController.addUserScript(WKUserScript(source: """
          window.barOnePrint = {
            status: () => window.webkit.messageHandlers.oneClubPrint.postMessage({action: 'status'}),
            print: request => window.webkit.messageHandlers.oneClubPrint.postMessage({...request, action: 'print'})
          };
          window.print = async function() {
            const receipt = Array.from(document.querySelectorAll('dialog[open] .bar-receipt, .printable')).pop();
            if (receipt) {
              const lines = Array.from(receipt.children).map(node => {
                if (!node.classList.contains('bar-row')) return node.innerText;
                const cells = Array.from(node.children).map(cell => cell.innerText.trim());
                if (cells.length !== 2) return cells.join(' ');
                const [left, right] = cells;
                return left.length + right.length < 42
                  ? left + ' '.repeat(42 - left.length - right.length) + right
                  : left + '\\n' + right.padStart(42);
              });
              return await window.barOnePrint.print({ id: crypto.randomUUID(), documentId: receipt.dataset.documentId || crypto.randomUUID(),
                role: receipt.dataset.printerRole || 'receipt', html: receipt.outerHTML, text: lines.join('\\n'), legacy: true });
            }
          };
          document.addEventListener('click', async function(event) {
            const link = event.target.closest && event.target.closest('a[download]');
            if (!link || !link.href.startsWith('blob:')) return;
            event.preventDefault();
            const blob = await (await fetch(link.href)).blob();
            if (blob.size > 10000000) return;
            window.webkit.messageHandlers.oneClubExport.postMessage({ name: link.download, text: await blob.text() });
          }, true);
          """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        #if DEBUG
        view.isInspectable = true
        #endif
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false
        view.scrollView.alwaysBounceVertical = false
        view.scrollView.alwaysBounceHorizontal = false
        view.scrollView.bouncesZoom = false
        context.coordinator.webView = view
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.path = "/"; components.fragment = "/bar"
        view.load(URLRequest(url: components.url!))
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeAllScriptMessageHandlers()
        uiView.navigationDelegate = nil; uiView.stopLoading()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
        let origin: URL
        let onError: (String?) -> Void
        weak var webView: WKWebView?
        init(origin: URL, onError: @escaping (String?) -> Void) { self.origin = origin; self.onError = onError }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, VenueAddress.sameOrigin(url, origin) else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onError(nil) }
        private func recordNavigationError(_ error: Error) {
            let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("BarOne-navigation-error.txt")
            try? String(describing: error).write(to: file, atomically: true, encoding: .utf8)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { recordNavigationError(error); onError("The installed register could not open: \(error.localizedDescription)") }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { onError("The register screen was interrupted. Open it again to continue.") }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { onError("Open the register again to recover your saved actions from this iPad.") }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            guard message.name == "oneClubPrint", message.frameInfo.isMainFrame,
                  let page = message.frameInfo.request.url, VenueAddress.sameOrigin(page, origin),
                  let content = message.body as? [String: Any], let webView else {
                replyHandler(nil, "Use the configured venue register to print."); return
            }
            Task { @MainActor in
                let manager = StarReceiptPrinter.shared
                if content["action"] as? String == "status" {
                    replyHandler(["configuredRoles": PrinterRole.allCases.filter { manager.printer(for: $0) != nil }.map(\.rawValue),
                                  "automaticRoles": manager.automaticRoles.map(\.rawValue)], nil)
                    return
                }
                guard content["action"] as? String == "print", let id = content["id"] as? String,
                      let documentID = content["documentId"] as? String, let text = content["text"] as? String,
                      let roleName = content["role"] as? String, let role = PrinterRole(rawValue: roleName) else {
                    replyHandler(nil, "The print request is incomplete."); return
                }
                let request = PrintRequest(id: id, documentID: documentID, origin: origin.absoluteString,
                    role: role, text: text, automatic: content["automatic"] as? Bool == true,
                    reprint: content["reprint"] as? Bool == true)
                if manager.printer(for: role) == nil, content["legacy"] as? Bool == true,
                   !request.automatic, let html = content["html"] as? String, html.utf8.count < 1_000_000 {
                    let info = UIPrintInfo(dictionary: nil); info.jobName = "Bar One ticket"; info.outputType = .general
                    let printer = UIPrintInteractionController.shared
                    printer.printInfo = info
                    printer.printFormatter = UIMarkupTextPrintFormatter(markupText: "<html><head><style>body{font:16px -apple-system;color:#000}.bar-row{display:flex;justify-content:space-between;margin:8px 0}</style></head><body>\(html)</body></html>")
                    printer.present(from: CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1), in: webView, animated: true) { _, complete, error in
                        if let error { replyHandler(nil, error.localizedDescription) }
                        else { replyHandler(["status": complete ? "submitted" : "canceled", "message": complete ? "Sent to the selected printer." : "Printing canceled."], nil) }
                    }
                    return
                }
                do { replyHandler(try await manager.submit(request), nil) }
                catch { replyHandler(nil, error.localizedDescription) }
            }
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url,
                  VenueAddress.sameOrigin(page, origin), let webView else { return }
            if message.name == "oneClubExport", let value = message.body as? [String: String], let text = value["text"], text.utf8.count <= 10_000_000 {
                let fileName = URL(fileURLWithPath: value["name"] ?? "one-club-export.txt").lastPathComponent
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                do {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let file = directory.appendingPathComponent(fileName)
                    try text.write(to: file, atomically: true, encoding: .utf8)
                    let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                    share.popoverPresentationController?.sourceView = webView
                    share.popoverPresentationController?.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1)
                    share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: directory) }
                    var parent = webView.window?.rootViewController
                    while let presented = parent?.presentedViewController { parent = presented }
                    parent?.present(share, animated: true)
                } catch { onError("The export could not be saved. Try again.") }
            }
        }
    }
}
