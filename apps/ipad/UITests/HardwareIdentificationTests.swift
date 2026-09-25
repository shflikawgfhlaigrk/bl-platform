import XCTest
import ExternalAccessory

final class HardwareIdentificationTests: XCTestCase {
    func testInspectNearbyBluetoothDevices() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BARONE_HARDWARE_INSPECTION"] == "1")
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.activate()
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 15))
        if settings.alerts.firstMatch.exists {
            capture(settings, "Bluetooth connection alert")
            if settings.alerts.buttons["OK"].exists { settings.alerts.buttons["OK"].tap() }
        }
        settings.buttons["com.apple.settings.bluetooth"].tap()
        RunLoop.current.run(until: Date().addingTimeInterval(3))
        capture(settings, "Bluetooth reader status and nearby devices")
        for index in 1...2 {
            settings.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.85))
                .press(forDuration: 0.1, thenDragTo: settings.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.35)))
            RunLoop.current.run(until: Date().addingTimeInterval(2))
            capture(settings, "Nearby Bluetooth devices page \(index)")
        }
    }

    func testReconnectKnownReader() throws {
        let name = ProcessInfo.processInfo.environment["BARONE_READER_NAME"] ?? ""
        try XCTSkipUnless(!name.isEmpty, "Requires the exact venue-observed reader name.")
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.activate()
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 15))
        settings.buttons["com.apple.settings.bluetooth"].tap()
        let reader = settings.cells.matching(NSPredicate(format: "label == %@", name)).firstMatch
        XCTAssertTrue(reader.waitForExistence(timeout: 8))
        reader.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(8))
        capture(settings, "Known card reader connection result")
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + " controls"
        tree.lifetime = .keepAlways
        add(tree)
    }

    func testInspectIPadConnections() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BARONE_HARDWARE_INSPECTION"] == "1")
        let accessories = EAAccessoryManager.shared().connectedAccessories.map {
            ["name": $0.name, "manufacturer": $0.manufacturer, "model": $0.modelNumber,
             "connected": String($0.isConnected), "protocols": $0.protocolStrings.joined(separator: ", ")]
        }
        let accessoryData = try JSONSerialization.data(withJSONObject: accessories, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(string: String(decoding: accessoryData, as: UTF8.self))
        attachment.name = "Connected iPad accessories"
        attachment.lifetime = .keepAlways
        add(attachment)
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.activate()
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 15))
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        capture(settings, "iPad connection settings")
        let bluetooth = settings.staticTexts["Bluetooth"].firstMatch
        if bluetooth.exists {
            bluetooth.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(5))
            capture(settings, "iPad Bluetooth devices")
        }
    }

    func testInspectExistingPOS() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BARONE_HARDWARE_INSPECTION"] == "1",
                          "Run only during the venue-authorized hardware inspection.")
        let bundle = ProcessInfo.processInfo.environment["BARONE_INSPECT_APP_BUNDLE"] ?? "g1.golfnow.one"
        let existing = XCUIApplication(bundleIdentifier: bundle.isEmpty ? "g1.golfnow.one" : bundle)
        existing.activate()
        XCTAssertTrue(existing.wait(for: .runningForeground, timeout: 15))
        RunLoop.current.run(until: Date().addingTimeInterval(3))
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "GN Pro hardware identification"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let tree = XCTAttachment(string: existing.debugDescription)
        tree.name = "GN Pro visible controls"
        tree.lifetime = .keepAlways
        add(tree)
    }

    func testInspectExistingPOSSettings() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BARONE_HARDWARE_INSPECTION"] == "1")
        let existing = XCUIApplication(bundleIdentifier: "g1.golfnow.one")
        existing.activate()
        XCTAssertTrue(existing.wait(for: .runningForeground, timeout: 15))
        if !existing.buttons["CARD READER"].exists {
            let settings = existing.buttons["ServerSettingsLockButton"]
            XCTAssertTrue(settings.waitForExistence(timeout: 10))
            settings.tap()
        }
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        capture(existing, "GN Pro register settings")
        for section in ["CARD READER", "PRINTING", "CASH REGISTERS"] {
            let control = existing.buttons[section]
            XCTAssertTrue(control.waitForExistence(timeout: 5))
            control.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(3))
            capture(existing, "GN Pro " + section)
        }
    }

    func testInspectLoadedPrinterSettings() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BARONE_HARDWARE_INSPECTION"] == "1")
        let existing = XCUIApplication(bundleIdentifier: "g1.golfnow.one")
        existing.activate()
        XCTAssertTrue(existing.wait(for: .runningForeground, timeout: 15))
        let printing = existing.buttons["PRINTING"]
        XCTAssertTrue(printing.waitForExistence(timeout: 5))
        printing.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(25))
        capture(existing, "GN Pro loaded printer assignments")
        existing.buttons["GENERAL"].tap()
        existing.buttons["More Info"].tap()
        RunLoop.current.run(until: Date().addingTimeInterval(3))
        capture(existing, "GN Pro account information")
    }

    func testInspectExistingMenu() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BARONE_HARDWARE_INSPECTION"] == "1")
        let existing = XCUIApplication(bundleIdentifier: "g1.golfnow.one")
        existing.activate()
        XCTAssertTrue(existing.wait(for: .runningForeground, timeout: 15))
        if existing.buttons["CLOSE"].exists {
            existing.buttons["GENERAL"].tap()
            existing.buttons["CLOSE"].tap()
        }
        let store = existing.buttons["StoreNav"]
        XCTAssertTrue(store.waitForExistence(timeout: 10))
        store.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(10))
        capture(existing, "GN Pro menu and categories")
    }

    func testInspectMenuPricePages() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BARONE_HARDWARE_INSPECTION"] == "1")
        let existing = XCUIApplication(bundleIdentifier: "g1.golfnow.one")
        existing.activate()
        XCTAssertTrue(existing.wait(for: .runningForeground, timeout: 15))
        for section in ["45 Grub", "HH Specials", "Buckets", "All Products"] {
            let category = existing.staticTexts[section].firstMatch
            XCTAssertTrue(category.waitForExistence(timeout: 5))
            category.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(2))
            capture(existing, "GN Pro prices " + section + " page 1")
            if section == "All Products" {
                for page in 2...4 {
                    existing.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.83))
                        .press(forDuration: 0.1, thenDragTo: existing.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.2)))
                    RunLoop.current.run(until: Date().addingTimeInterval(1))
                    capture(existing, "GN Pro prices All Products page \(page)")
                }
            }
        }
    }

    func testInspectPaginatedMenuPrices() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BARONE_HARDWARE_INSPECTION"] == "1")
        let existing = XCUIApplication(bundleIdentifier: "g1.golfnow.one")
        existing.activate()
        XCTAssertTrue(existing.wait(for: .runningForeground, timeout: 15))
        existing.staticTexts["Bar One"].firstMatch.tap()
        existing.staticTexts["All Products"].firstMatch.tap()
        for page in 1...30 {
            RunLoop.current.run(until: Date().addingTimeInterval(1))
            capture(existing, "GN Pro all product prices page \(page)")
            let next = existing.buttons["NEXT"]
            if !next.exists { return }
            next.tap()
        }
        XCTFail("Catalog exceeds inspection page limit; continue from the last captured page.")
    }
}
