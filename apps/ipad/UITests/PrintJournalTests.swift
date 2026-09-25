import XCTest

@MainActor
final class PrintJournalTests: XCTestCase {
    private func request(id: String = "job-1", text: String = "Ticket 42", reprint: Bool = false, automatic: Bool = true) -> PrintRequest {
        PrintRequest(id: id, documentID: "ticket-42", origin: "https://venue.example", role: .kitchen,
                     text: text, automatic: automatic, reprint: reprint)
    }
    func testRestartPreservesAmbiguousPrintAndBlocksAutomaticRetry() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("journal.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let first = PrintJournal(file: file)
        _ = try first.prepare(request())
        try first.set(request(), status: .sending, detail: "Sending")
        let reopened = PrintJournal(file: file)
        XCTAssertEqual(try reopened.prepare(request()).status, .unknown)
        XCTAssertEqual(try reopened.prepare(request(id: "fresh-id")).status, .unknown)
        XCTAssertEqual(try reopened.prepare(request(id: "copy", reprint: true, automatic: false)).status, .prepared)
    }
    func testAcknowledgedPrintIsDeduplicatedAndContentCannotChangeUnderSameKey() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("journal.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let journal = PrintJournal(file: file)
        _ = try journal.prepare(request())
        try journal.set(request(), status: .submitted, detail: "Printer acknowledged")
        XCTAssertEqual(try journal.prepare(request(id: "another-id")).status, .submitted)
        XCTAssertThrowsError(try journal.prepare(request(text: "Different total")))
        XCTAssertThrowsError(try journal.prepare(request(id: "bad-auto", reprint: true)))
        XCTAssertEqual(try journal.prepare(request(id: "revision-2", text: "VOID — Ticket 42")).status, .prepared)
    }
    func testFailureBeforeSendCanRetryButCorruptHistoryStopsPrinting() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("journal.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let journal = PrintJournal(file: file)
        _ = try journal.prepare(request())
        try journal.set(request(), status: .failed, detail: "Printer offline before send")
        XCTAssertEqual(try PrintJournal(file: file).prepare(request()).status, .prepared)
        try Data("invalid history".utf8).write(to: file)
        XCTAssertThrowsError(try PrintJournal(file: file).prepare(request()))
    }
}
