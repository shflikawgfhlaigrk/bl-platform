import Foundation
import CryptoKit

enum PrinterRole: String, Codable, CaseIterable, Identifiable {
    case receipt, bar, kitchen
    var id: String { rawValue }
    var title: String {
        switch self { case .receipt: return "Guest receipts"; case .bar: return "Bar tickets"; case .kitchen: return "Kitchen tickets" }
    }
}

struct PrintRequest {
    let id: String
    let documentID: String
    let origin: String
    let role: PrinterRole
    let text: String
    let automatic: Bool
    let reprint: Bool
}

struct PrintRecord: Codable, Identifiable {
    enum Status: String, Codable { case prepared, sending, submitted, failed, unknown }
    let id: String
    let documentID: String
    let origin: String
    let role: PrinterRole
    let fingerprint: String
    let createdAt: Date
    var updatedAt: Date
    var status: Status
    var detail: String
}

/// Persist intent before sending; a lost acknowledgement never causes an automatic retry.
@MainActor
final class PrintJournal: ObservableObject {
    @Published private(set) var records: [PrintRecord] = []
    private let file: URL
    private var loadError: Error?

    init(file: URL) {
        self.file = file
        do {
            if FileManager.default.fileExists(atPath: file.path) {
                records = try JSONDecoder().decode([PrintRecord].self, from: Data(contentsOf: file))
                for index in records.indices where records[index].status == .sending {
                    records[index].status = .unknown
                    records[index].detail = "The app restarted before printing was confirmed. Check the paper."
                }
                try persist()
            }
        } catch { loadError = error }
    }

    static func fingerprint(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Returns a completed/uncertain record for reconciliation, or a prepared record to send.
    func prepare(_ request: PrintRequest) throws -> PrintRecord {
        guard loadError == nil else { throw failure("Print history could not be read. Resolve it before printing.") }
        guard !request.id.isEmpty, request.id.utf8.count <= 200,
              !request.documentID.isEmpty, request.documentID.utf8.count <= 200,
              !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              request.text.utf8.count <= 100_000 else { throw failure("Invalid print request.") }
        guard !(request.automatic && request.reprint) else { throw failure("Automatic reprints are not permitted.") }
        let hash = Self.fingerprint(request.text)
        if let prior = records.first(where: { $0.id == request.id && $0.origin == request.origin }) {
            guard prior.fingerprint == hash, prior.documentID == request.documentID, prior.role == request.role else {
                throw failure("This print request identifier belongs to a different document.")
            }
            if [.submitted, .sending, .unknown].contains(prior.status) { return prior }
        }
        let related = records.filter { $0.origin == request.origin && $0.documentID == request.documentID && $0.role == request.role }
        if !request.reprint {
            if let uncertain = related.last(where: { [.unknown, .sending].contains($0.status) }) { return uncertain }
            if let complete = related.last(where: { $0.fingerprint == hash && $0.status == .submitted }) { return complete }
        }
        let now = Date()
        let next = PrintRecord(id: request.id, documentID: request.documentID, origin: request.origin,
            role: request.role, fingerprint: hash, createdAt: now, updatedAt: now,
            status: .prepared, detail: "Prepared; nothing sent yet.")
        if let index = records.firstIndex(where: { $0.id == request.id && $0.origin == request.origin }) { records[index] = next }
        else { records.append(next) }
        do { try persist() } catch { loadError = error; throw failure("Print intent could not be saved. Nothing was sent.") }
        return next
    }

    func set(_ request: PrintRequest, status: PrintRecord.Status, detail: String) throws {
        guard let index = records.firstIndex(where: { $0.id == request.id && $0.origin == request.origin }) else {
            throw failure("Print intent is missing.")
        }
        records[index].status = status
        records[index].updatedAt = Date()
        records[index].detail = String(detail.prefix(500))
        do { try persist() } catch { loadError = error; throw error }
    }

    private func persist() throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(records).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "BarOnePrintJournal", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
