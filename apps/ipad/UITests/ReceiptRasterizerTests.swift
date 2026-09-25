import XCTest
import UIKit

@MainActor
final class ReceiptRasterizerTests: XCTestCase {
    func testLongReceiptKeepsEveryCharacterAndTransactionID() throws {
        let text = "BAR ONE\n" + String(repeating: "Piña Colada — crème de coco $12.50\n", count: 160)
            + "Transaction ID: venue-transaction-123456789\nTotal: $2,000.00\n"
        let pages = try ReceiptRasterizer.pages(for: text)
        XCTAssertGreaterThan(pages.count, 1)
        var reconstructed = ""
        for page in pages {
            reconstructed += (text as NSString).substring(with: page.characters)
            XCTAssertEqual(page.image.size.width, 576)
            XCTAssertLessThanOrEqual(page.image.size.height, 2004)
            XCTAssertEqual(page.image.scale, 1)
            let cg = try XCTUnwrap(page.image.cgImage)
            var pixels = [UInt8](repeating: 255, count: cg.width * cg.height * 4)
            let context = try XCTUnwrap(CGContext(data: &pixels, width: cg.width, height: cg.height,
                bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            XCTAssertTrue(stride(from: 0, to: pixels.count, by: 4).contains { pixels[$0] < 128 },
                          "Every receipt page must contain visible ink.")
        }
        XCTAssertEqual(reconstructed, text, "Wrapping must preserve the final total and provider reference.")
        for (name, page) in [("Receipt first page", pages.first), ("Receipt transaction and total", pages.last)] {
            if let page {
                let attachment = XCTAttachment(image: page.image)
                attachment.name = name
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    func testEmptyAndOversizedReceiptsFailBeforePrinting() {
        XCTAssertThrowsError(try ReceiptRasterizer.pages(for: "\n  "))
        XCTAssertThrowsError(try ReceiptRasterizer.pages(for: String(repeating: "x", count: 100_001)))
    }
}
