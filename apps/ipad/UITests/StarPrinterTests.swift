import XCTest

final class StarPrinterTests: XCTestCase {
    func testVenuePrinterConnectionAndRoles() throws {
        let address = ProcessInfo.processInfo.environment["BARONE_PRINTER_IP"] ?? ""
        try XCTSkipUnless(!address.isEmpty, "Requires the venue-confirmed printer address.")
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["Receipt printer"].waitForExistence(timeout: 15))
        app.buttons["Receipt printer"].tap()
        let role = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Printer use")).firstMatch
        for title in ["Bar tickets", "Kitchen tickets", "Guest receipts"] {
            XCTAssertTrue(role.waitForExistence(timeout: 5))
            role.tap()
            app.buttons[title].tap()
            if title != "Guest receipts" {
                XCTAssertTrue(app.switches["Print queued tickets automatically"].exists)
            }
        }
        let addressField = app.textFields["printer-network-address"]
        addressField.tap()
        addressField.typeText(address)
        app.buttons["Connect by IP"].tap()
        let status = app.staticTexts["printer-discovery-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 30))
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "Bar One verified printer roles and direct connection result"
        tree.lifetime = .keepAlways
        add(tree)
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = "Bar One direct printer connection"
        image.lifetime = .keepAlways
        add(image)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Connection"].waitForExistence(timeout: 5))
    }

    func testRejectMalformedNetworkAddressWithoutSavingPrinter() throws {
        let app = XCUIApplication()
        app.launch()
        let setup = app.buttons["Receipt printer"]
        XCTAssertTrue(setup.waitForExistence(timeout: 15))
        setup.tap()
        let field = app.textFields["printer-network-address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("999.1.2.3")
        app.buttons["Connect by IP"].tap()
        XCTAssertTrue(app.staticTexts["printer-discovery-status"].label.hasPrefix("Enter the printer’s IPv4 address"))
        XCTAssertFalse(app.buttons["Print test receipt"].exists)
    }

    func testDiscoverReceiptPrinter() throws {
        try discover(bluetooth: false)
    }

    func testDiscoverBluetoothReceiptPrinter() throws {
        try discover(bluetooth: true)
    }

    func testOpenBluetoothPairing() throws {
        try discover(bluetooth: true, pair: true)
    }

    private func discover(bluetooth: Bool, pair: Bool = false) throws {
        let app = XCUIApplication()
        app.launch()
        defer {
            let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            image.name = "Star receipt printer discovery"
            image.lifetime = .keepAlways
            add(image)
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "Star printer accessibility"
            tree.lifetime = .keepAlways
            add(tree)
        }
        let setup = app.buttons["Receipt printer"]
        XCTAssertTrue(setup.waitForExistence(timeout: 15))
        setup.tap()
        XCTAssertTrue(app.buttons["Find printers"].waitForExistence(timeout: 5))
        if bluetooth {
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Printer connection")).firstMatch.tap()
            let choice = app.buttons["Bluetooth"]
            XCTAssertTrue(choice.waitForExistence(timeout: 5))
            choice.tap()
        }
        addUIInterruptionMonitor(withDescription: "Bar One printer access") { alert in
            guard alert.label.contains("Bar One") else { return false }
            for label in ["Allow", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        app.buttons["Find printers"].tap()
        app.tap()
        let done = app.buttons["Find printers"]
        XCTAssertTrue(done.waitForExistence(timeout: 20))
        XCTAssertTrue(done.isEnabled, "Discovery must finish within its bounded timeout.")
        let status = app.staticTexts["printer-discovery-status"]
        XCTAssertTrue(status.label.hasPrefix("No Star printer found.") || status.label.hasPrefix("Select the receipt printer"),
                      "Discovery must complete without an interface or permission error: \(status.label)")
        if pair {
            app.buttons["Pair Bluetooth printer"].tap()
            XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 10),
                          "The system Bluetooth accessory picker must open.")
            // Allow nearby accessories to advertise before recording the list.
            RunLoop.current.run(until: Date().addingTimeInterval(12))
        }
    }
}
