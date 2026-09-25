import Foundation
import SQLite3
import Security
import CryptoKit
import WebKit

/// The venue database belongs to the iPad's app container. No network service
/// or Mac filesystem path participates in opening, saving, or recovering it.
final class LocalRegisterStore: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = LocalRegisterStore()
    private let queue = DispatchQueue(label: "com.blacklabel.barone.sqlite")
    private var database: OpaquePointer?
    private let fm = FileManager.default
    private var root: URL { fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("BarOne", isDirectory: true) }
    private var documents: URL { fm.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    private var dbURL: URL { root.appendingPathComponent("platform.sqlite") }
    private func failure(_ message: String) -> NSError { NSError(domain: "BarOneStorage", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func secret(_ name: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.blacklabel.oneclub.local", kSecAttrAccount as String: name, kSecReturnData as String: true]
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw failure("Unlock the iPad to open protected register storage (\(status)).") }
        return value as? Data
    }
    private func saveSecret(_ name: String, _ value: Data) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.blacklabel.oneclub.local", kSecAttrAccount as String: name]
        let values: [String: Any] = [kSecValueData as String: value, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(values) { _, b in b } as CFDictionary, nil) == errSecSuccess else { throw failure("Protected register storage could not be saved.") }
        } else if status != errSecSuccess { throw failure("Protected register storage could not be updated.") }
    }
    private func openDatabase(_ url: URL, readOnly: Bool = false) throws -> OpaquePointer {
        var handle: OpaquePointer?
        let flags = readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        let result = sqlite3_open_v2(url.path, &handle, flags, nil)
        guard result == SQLITE_OK, let handle else {
            if let handle { sqlite3_close(handle) }
            throw failure("The register database could not be opened (\(result)).")
        }
        sqlite3_busy_timeout(handle, 5000)
        return handle
    }
    private func validate(_ url: URL) throws -> [String: Int] {
        let handle = try openDatabase(url, readOnly: true); defer { sqlite3_close(handle) }
        let integrity = try execute(handle, "pragma integrity_check", [])
        guard let rows = integrity["rows"] as? [[String: Any]], rows.count == 1, rows[0]["integrity_check"] as? String == "ok" else { throw failure("Database integrity verification failed.") }
        let foreign = try execute(handle, "pragma foreign_key_check", [])
        guard (foreign["rows"] as? [[String: Any]])?.isEmpty == true else { throw failure("Database reference verification failed.") }
        var counts = [String: Int]()
        for table in ["tenants", "users", "api_pos_credentials", "api_bar_documents", "api_bar_commands", "orders_orders", "orders_tenders", "catalog_variations"] {
            let result = try execute(handle, "select count(*) as n from \(table)", [])
            counts[table] = ((result["rows"] as? [[String: Any]])?.first?["n"] as? NSNumber)?.intValue ?? 0
        }
        guard counts["tenants"] == 1, (counts["api_pos_credentials"] ?? 0) > 0 else { throw failure("The transfer has no configured venue or operator PIN.") }
        return counts
    }
    private func initialize() throws -> [String: Any] {
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        try fm.createDirectory(at: documents, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: dbURL.path) {
            let transfer = documents.appendingPathComponent("BarOne-transfer", isDirectory: true)
            let source = transfer.appendingPathComponent("platform.sqlite")
            guard fm.fileExists(atPath: source.path) else { throw failure("Transfer the venue data to this iPad to finish installation. Existing records are preserved.") }
            let sourceCounts = try validate(source)
            let key = try Data(contentsOf: transfer.appendingPathComponent("admin.key"))
            guard key.count == 32 else { throw failure("The transferred credential key is invalid.") }
            let incoming = root.appendingPathComponent("incoming.sqlite")
            if fm.fileExists(atPath: incoming.path) { try fm.removeItem(at: incoming) }
            try fm.copyItem(at: source, to: incoming)
            guard try validate(incoming) == sourceCounts else { throw failure("The transferred row counts changed.") }
            let files = transfer.appendingPathComponent("files", isDirectory: true)
            let destFiles = root.appendingPathComponent("files", isDirectory: true)
            if fm.fileExists(atPath: files.path), !fm.fileExists(atPath: destFiles.path) { try fm.copyItem(at: files, to: destFiles) }
            try saveSecret("masterKey", key)
            try saveSecret("session", Data())
            try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: incoming.path)
            try fm.moveItem(at: incoming, to: dbURL)
            let receipt: [String: Any] = ["importedAt": ISO8601DateFormatter().string(from: Date()), "counts": sourceCounts,
                "sha256": SHA256.hash(data: try Data(contentsOf: source)).map { String(format: "%02x", $0) }.joined(), "runtime": "iPad"]
            try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]).write(to: documents.appendingPathComponent("BarOne-transfer-receipt.json"), options: .atomic)
            // The protected database and Keychain now hold the verified data.
            try fm.removeItem(at: transfer)
        }
        if database == nil { database = try openDatabase(dbURL) }
        guard let database, let key = try secret("masterKey"), key.count == 32 else { throw failure("The register credential key needs recovery.") }
        // Recover a web content process termination without retaining its transaction.
        if sqlite3_get_autocommit(database) == 0 { _ = try execute(database, "rollback", []) }
        _ = try execute(database, "pragma journal_mode=WAL", [])
        _ = try execute(database, "pragma synchronous=FULL", [])
        _ = try execute(database, "pragma foreign_keys=ON", [])
        return ["masterKey": key.base64EncodedString(), "cookie": String(data: try secret("session") ?? Data(), encoding: .utf8) ?? ""]
    }
    private func execute(_ handle: OpaquePointer, _ sql: String, _ parameters: [Any]) throws -> [String: Any] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure(String(cString: sqlite3_errmsg(handle))) }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_bind_parameter_count(statement) == parameters.count else { throw failure("SQL parameter count mismatch.") }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in parameters.enumerated() {
            let position = Int32(index + 1)
            let status: Int32
            if value is NSNull { status = sqlite3_bind_null(statement, position) }
            else if let value = value as? String { status = sqlite3_bind_text(statement, position, value, -1, transient) }
            else if let value = value as? NSNumber {
                let number = value.doubleValue
                if number.isFinite, number.rounded() == number, abs(number) <= 9007199254740991 { status = sqlite3_bind_int64(statement, position, value.int64Value) }
                else { status = sqlite3_bind_double(statement, position, number) }
            } else { throw failure("Unsupported SQL parameter type.") }
            guard status == SQLITE_OK else { throw failure("SQL parameter could not be bound.") }
        }
        var rows = [[String: Any]]()
        var status = sqlite3_step(statement)
        while status == SQLITE_ROW {
            var row = [String: Any]()
            for column in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_INTEGER: row[name] = NSNumber(value: sqlite3_column_int64(statement, column))
                case SQLITE_FLOAT: row[name] = NSNumber(value: sqlite3_column_double(statement, column))
                case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(statement, column))
                case SQLITE_BLOB:
                    let size = Int(sqlite3_column_bytes(statement, column))
                    row[name] = sqlite3_column_blob(statement, column).map { Data(bytes: $0, count: size).base64EncodedString() } ?? ""
                default: row[name] = NSNull()
                }
            }
            rows.append(row); status = sqlite3_step(statement)
        }
        guard status == SQLITE_DONE else { throw failure(String(cString: sqlite3_errmsg(handle))) }
        return ["rows": rows, "changes": String(sqlite3_changes64(handle)), "insertId": String(sqlite3_last_insert_rowid(handle))]
    }
    private func allowedBackup(_ name: String) throws -> URL {
        guard name == URL(fileURLWithPath: name).lastPathComponent, name.hasPrefix("BarOne-"), name.hasSuffix(".baronebackup") || name.hasSuffix(".verify.sqlite") else { throw failure("Invalid backup name.") }
        return documents.appendingPathComponent(name)
    }
    private func snapshot() throws -> URL {
        let dest = root.appendingPathComponent("snapshot-\(UUID().uuidString).sqlite")
        let source = try openDatabase(dbURL, readOnly: true); defer { sqlite3_close(source) }
        var target: OpaquePointer?
        guard sqlite3_open(dest.path, &target) == SQLITE_OK, let target else { throw failure("Backup storage could not be created.") }
        defer { sqlite3_close(target) }
        guard let backup = sqlite3_backup_init(target, "main", source, "main") else { throw failure("Backup could not begin.") }
        let status = sqlite3_backup_step(backup, -1)
        let finished = sqlite3_backup_finish(backup)
        guard status == SQLITE_DONE, finished == SQLITE_OK else { throw failure("Backup did not finish.") }
        _ = try execute(target, "pragma journal_mode=DELETE", [])
        _ = try validate(dest)
        return dest
    }
    private func handle(_ message: [String: Any]) throws -> Any {
        let action = message["action"] as? String ?? ""
        if action == "open" { return try initialize() }
        guard let database else { throw failure("Open the register database first.") }
        switch action {
        case "query":
            guard let sql = message["sql"] as? String, sql.utf8.count < 1_000_000 else { throw failure("Invalid SQL request.") }
            return try execute(database, sql, message["parameters"] as? [Any] ?? [])
        case "session": try saveSecret("session", Data((message["cookie"] as? String ?? "").utf8)); return true
        case "backup":
            let snapshot = try snapshot(); defer { try? fm.removeItem(at: snapshot) }
            guard let key = try secret("masterKey") else { throw failure("Backup key is unavailable.") }
            let encrypted = try AES.GCM.seal(Data(contentsOf: snapshot), using: SymmetricKey(data: key)).combined!
            let name = "BarOne-\(UUID().uuidString).baronebackup"
            try encrypted.write(to: allowedBackup(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return ["path": name, "bytes": encrypted.count, "sha256": SHA256.hash(data: encrypted).map { String(format: "%02x", $0) }.joined()]
        case "backupRestore":
            let url = try allowedBackup(message["path"] as? String ?? "")
            guard let key = try secret("masterKey") else { throw failure("Backup key is unavailable.") }
            let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: Data(contentsOf: url)), using: SymmetricKey(data: key))
            let name = "BarOne-\(UUID().uuidString).verify.sqlite"
            try plain.write(to: allowedBackup(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return ["tempPath": name]
        case "backupCheck": return ["ok": true, "detail": try validate(allowedBackup(message["path"] as? String ?? ""))]
        case "backupCleanup":
            let name = message["path"] as? String ?? ""
            guard name.hasSuffix(".verify.sqlite") else { throw failure("Only temporary verification copies can be cleaned up.") }
            try fm.removeItem(at: allowedBackup(name)); return true
        case "filePut", "fileGet", "fileExists", "fileDelete":
            let key = message["key"] as? String ?? ""
            guard key.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil else { throw failure("Invalid document key.") }
            let folder = root.appendingPathComponent("files", isDirectory: true)
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent(key)
            if action == "fileGet" { return try Data(contentsOf: file).base64EncodedString() }
            if action == "fileExists" { return fm.fileExists(atPath: file.path) }
            if action == "fileDelete" { if fm.fileExists(atPath: file.path) { try fm.removeItem(at: file) }; return true }
            guard let data = Data(base64Encoded: message["data"] as? String ?? "") else { throw failure("Invalid document data.") }
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); return true
        case "runtimeError":
            try Data((message["message"] as? String ?? "Unknown runtime error").prefix(2000).utf8).write(to: documents.appendingPathComponent("BarOne-runtime-error.txt"), options: .atomic)
            return true
        default: throw failure("Unknown storage action.")
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, url.scheme == "barone", url.host == "register", let content = message.body as? [String: Any] else { replyHandler(nil, "Only the installed register can access its database."); return }
        queue.async {
            do { let result = try self.handle(content); DispatchQueue.main.async { replyHandler(result, nil) } }
            catch { DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) } }
        }
    }
}

final class LocalRegisterAssets: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == "barone", url.host == "register",
              let root = Bundle.main.url(forResource: "Register", withExtension: nil) else { urlSchemeTask.didFailWithError(URLError(.badURL)); return }
        let relative = url.path == "/" || url.path.isEmpty ? "index.html" : String(url.path.dropFirst())
        // iOS exposes bundle paths through /var and /private/var aliases.
        // Canonicalize BOTH sides before enforcing resource containment.
        let assetRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let file = assetRoot.appendingPathComponent(relative).resolvingSymlinksInPath().standardizedFileURL
        guard file.path.hasPrefix(assetRoot.path + "/"), !relative.hasPrefix("api/") else {
            let diagnostic = "Asset containment failed: \(relative); root=\(assetRoot.path); file=\(file.path)"
            let report = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("BarOne-assets-error.txt")
            try? diagnostic.write(to: report, atomically: true, encoding: .utf8)
            urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile)); return
        }
        do {
            let data = try Data(contentsOf: file)
            let types = ["html": "text/html", "js": "application/javascript", "mjs": "application/javascript", "css": "text/css", "json": "application/json", "png": "image/png", "svg": "image/svg+xml", "webmanifest": "application/manifest+json", "woff2": "font/woff2"]
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": types[file.pathExtension] ?? "application/octet-stream", "Content-Length": String(data.count), "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self' barone: blob:; script-src 'self' barone:; style-src 'self' barone: 'unsafe-inline'; connect-src 'self' barone: blob:; object-src 'none'; base-uri 'self'"])!
            urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
