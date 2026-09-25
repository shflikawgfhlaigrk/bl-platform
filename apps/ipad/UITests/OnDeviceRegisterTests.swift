import XCTest

final class OnDeviceRegisterTests: XCTestCase {
    func testOnDeviceBackup() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        defer { capture(app, "Bar One verified iPad backup") }
        XCTAssertTrue(app.buttons["Drink guide"].waitForExistence(timeout: 30))
        let settings = app.links["Settings"]
        app.buttons["Show or hide navigation"].tap()
        XCTAssertTrue(settings.waitForExistence(timeout: 5)); settings.tap()
        XCTAssertTrue(app.buttons["Backups"].waitForExistence(timeout: 10)); app.buttons["Backups"].tap()
        XCTAssertTrue(app.buttons["Run backup now"].waitForExistence(timeout: 10)); app.buttons["Run backup now"].tap()
        XCTAssertTrue(app.staticTexts["yes"].firstMatch.waitForExistence(timeout: 30))
        capture(app, "Encrypted backup created and verified on iPad")
        let bar = app.links["Bar service"]
        if !bar.isHittable { app.buttons["Show or hide navigation"].tap() }
        bar.tap(); XCTAssertTrue(app.buttons["Drink guide"].waitForExistence(timeout: 10))
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let picture = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        picture.name = name; picture.lifetime = .keepAlways; add(picture)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + " accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func testLocalMenuAndRestart() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        defer { capture(app, "Bar One installed iPad runtime") }
        XCTAssertTrue(app.staticTexts["Bar One · Saved on this iPad"].waitForExistence(timeout: 15))
        let loaded = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Sign in", "Drink guide")).firstMatch
        XCTAssertTrue(loaded.waitForExistence(timeout: 45))
        if app.buttons["Sign in"].exists {
            let value = try XCTUnwrap(ProcessInfo.processInfo.environment["BARONE_OPERATOR_PIN"])
            XCTAssertEqual(value.count, 4)
            let pin = app.secureTextFields.firstMatch; pin.tap(); pin.typeText(value)
            app.buttons["Sign in"].tap()
        }
        XCTAssertTrue(app.buttons["Drink guide"].waitForExistence(timeout: 30))
        app.buttons["Cocktails"].tap()
        let oldFashioned = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Old Fashioned", "$12.00")).firstMatch
        XCTAssertTrue(oldFashioned.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Connection"].exists)
        capture(app, "Bar One native menu before restart")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Drink guide"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["Sign in"].exists)
        app.buttons["Cocktails"].tap()
        XCTAssertTrue(oldFashioned.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Save & next"].isHittable)
    }

    func testLocalSaveBillAndRestart() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        defer { capture(app, "Bar One on-device saved bill verification") }
        XCTAssertTrue(app.buttons["Drink guide"].waitForExistence(timeout: 30))
        app.buttons["Save & next"].tap()
        XCTAssertTrue(app.staticTexts["Next guest"].waitForExistence(timeout: 10))
        app.buttons["Cocktails"].tap()
        let item = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Old Fashioned", "$12.00")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10)); item.tap()
        XCTAssertTrue(app.buttons["Name bill"].waitForExistence(timeout: 10))
        let name = "iPad verification " + String(UUID().uuidString.prefix(6))
        app.buttons["Name bill"].tap()
        let bill = app.textFields["Bill name"]; XCTAssertTrue(bill.waitForExistence(timeout: 5)); bill.tap(); bill.typeText(name)
        app.buttons["Save bill name"].tap()
        XCTAssertTrue(app.buttons["Save & next"].waitForExistence(timeout: 10)); app.buttons["Save & next"].tap()
        XCTAssertTrue(app.staticTexts["Next guest"].waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Drink guide"].waitForExistence(timeout: 30))
        let saved = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10)); saved.tap()
        XCTAssertTrue(app.buttons["Name bill"].waitForExistence(timeout: 10))
        capture(app, "Bill recovered from iPad after restart")
        app.buttons["Manage"].tap(); app.buttons["Cancel unpaid tab"].tap()
        let reason = app.textFields["Reason"]; XCTAssertTrue(reason.waitForExistence(timeout: 5)); reason.tap()
        reason.typeText("On-device storage verification complete; no order sent or payment taken")
        app.buttons["Cancel tab"].tap()
        XCTAssertTrue(app.staticTexts["Next guest"].waitForExistence(timeout: 10))
    }
}
