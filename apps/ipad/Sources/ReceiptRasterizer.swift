import UIKit
import CoreText

/// TSP100III printers require graphic commands, including for receipt text.
@MainActor
enum ReceiptRasterizer {
    static let width = 576
    struct Page {
        let image: UIImage
        let characters: NSRange
    }

    static func pages(for text: String) throws -> [Page] {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 100_000 else { throw invalid("Receipt content is empty or too large.") }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = 3
        let content = NSAttributedString(string: text, attributes: [
            .font: UIFont.monospacedSystemFont(ofSize: 20, weight: .regular),
            .foregroundColor: UIColor.black,
            .paragraphStyle: paragraph
        ])
        let framesetter = CTFramesetterCreateWithAttributedString(content)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        var offset = 0
        var pages: [Page] = []
        while offset < content.length {
            guard pages.count < 128 else { throw invalid("Receipt is too long to print in one request.") }
            let remaining = CFRange(location: offset, length: content.length - offset)
            var fitted = CFRange()
            let size = CTFramesetterSuggestFrameSizeWithConstraints(framesetter, remaining, nil,
                CGSize(width: CGFloat(width - 32), height: 2000), &fitted)
            guard fitted.length > 0 else { throw invalid("Receipt text could not be laid out.") }
            let height = ceil(size.height) + 4
            let path = CGPath(rect: CGRect(x: 0, y: 0, width: CGFloat(width - 32), height: height), transform: nil)
            let frame = CTFramesetterCreateFrame(framesetter, fitted, path, nil)
            let visible = CTFrameGetVisibleStringRange(frame)
            guard visible.location == offset, visible.length == fitted.length else {
                throw invalid("Receipt layout was incomplete. Nothing was sent to the printer.")
            }
            let image = UIGraphicsImageRenderer(size: CGSize(width: CGFloat(width), height: height), format: format).image { context in
                UIColor.white.setFill()
                context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: height))
                let cg = context.cgContext
                cg.textMatrix = .identity
                cg.translateBy(x: 16, y: height)
                cg.scaleBy(x: 1, y: -1)
                CTFrameDraw(frame, cg)
            }
            pages.append(Page(image: image, characters: NSRange(location: offset, length: visible.length)))
            offset += visible.length
        }
        return pages
    }

    private static func invalid(_ message: String) -> NSError {
        NSError(domain: "BarOneReceiptRasterizer", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
