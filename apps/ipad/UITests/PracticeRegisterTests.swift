import XCTest

final class PracticeRegisterTests: XCTestCase {
    func testVenueAddUpsellsAndBillName() throws {
        continueAfterFailure = false
        let origin = try XCTUnwrap(ProcessInfo.processInfo.environment["ONECLUB_TEST_ORIGIN"])
        XCTAssertEqual(origin, "https://bar-one-pos.michael-070.workers.dev")
        let app = XCUIApplication()
        app.launchEnvironment["ONECLUB_CONFIGURE_SERVER"] = origin
        app.launch()
        XCTAssertTrue(app.buttons["Service"].waitForExistence(timeout: 30))
        app.buttons["+ New"].tap()
        let name = "Add verification " + String(UUID().uuidString.prefix(6))
        let guest = app.textFields["Guest or tab name"]
        XCTAssertTrue(guest.waitForExistence(timeout: 5)); guest.tap(); guest.typeText(name)
        let bill = app.textFields["Bill name"]
        bill.tap(); bill.typeText("Verification bill")
        app.buttons["Open tab"].tap()
        XCTAssertTrue(app.buttons["Name bill"].waitForExistence(timeout: 10))
        app.buttons["Lunch / dinner"].tap()
        let burger = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Double Smash Burger", "$14.00")).firstMatch
        let servicePosition = app.buttons["Service"].frame.origin
        XCTAssertTrue(burger.waitForExistence(timeout: 5)); burger.tap()
        XCTAssertTrue(app.staticTexts["Onion rings"].firstMatch.waitForExistence(timeout: 5))
        app.staticTexts["Onion rings"].firstMatch.tap()
        app.staticTexts["Bottled Water"].firstMatch.tap()
        let add = app.buttons["Add to bill · $17.50"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        capture(app, name: "Bar One priced onion-ring and water upsells")
        add.tap()
        XCTAssertTrue(app.buttons["Name bill"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Side: Onion rings"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Pending setup"].firstMatch.exists)
        XCTAssertEqual(app.buttons["Service"].frame.origin.y, servicePosition.y, accuracy: 1)
        XCTAssertTrue(app.buttons["Save & next"].isHittable)
        app.buttons["Name bill"].tap()
        let rename = app.textFields["Bill name"]
        XCTAssertTrue(rename.waitForExistence(timeout: 5)); rename.tap()
        rename.typeText("Michael verification")
        XCTAssertEqual(rename.value as? String, "Michael verification")
        app.buttons["Save bill name"].tap()
        capture(app, name: "Bar One saved items and named bill")
        let next = app.buttons["Save & next"]
        XCTAssertTrue(next.isHittable)
        XCTAssertLessThanOrEqual(next.frame.maxY, app.frame.maxY)
        next.tap()
        XCTAssertTrue(app.staticTexts["Next guest"].waitForExistence(timeout: 10))
        capture(app, name: "Bar One next guest with saved tab")
        let savedTab = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", name, "Michael verification")).firstMatch
        XCTAssertTrue(savedTab.waitForExistence(timeout: 5)); savedTab.tap()
        XCTAssertTrue(app.buttons["Name bill"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Side: Onion rings"].firstMatch.exists)
        app.buttons["Manage"].tap()
        app.buttons["Cancel unpaid tab"].tap()
        let reason = app.textFields["Reason"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5)); reason.tap()
        reason.typeText("Physical Add and upsell verification; no service or payment sent")
        app.buttons["Cancel tab"].tap()
        XCTAssertTrue(app.buttons["+ New"].waitForExistence(timeout: 10))
        capture(app, name: "Bar One verification tab canceled")
    }

    func testConfiguredPhotoMenu() throws {
        continueAfterFailure = false
        let origin = try XCTUnwrap(ProcessInfo.processInfo.environment["ONECLUB_TEST_ORIGIN"])
        let app = XCUIApplication()
        app.launchEnvironment["ONECLUB_CONFIGURE_SERVER"] = origin
        // Keep the operator's current physical orientation.
        app.launch()
        defer { capture(app, name: "Bar One photo menu") }
        let loaded = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Sign in", "Drink guide")).firstMatch
        XCTAssertTrue(loaded.waitForExistence(timeout: 35))
        if app.buttons["Sign in"].exists {
            XCTAssertTrue(String(describing: app.otherElements["Register operator"].value).contains("Club Manager"))
            let pin = app.secureTextFields.firstMatch
            pin.tap()
            pin.typeText("2468")
            app.buttons["Sign in"].tap()
        }
        XCTAssertTrue(app.buttons["Drink guide"].waitForExistence(timeout: 20))
        app.buttons["Breakfast"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Biscuits and gravy", "$8.00")).firstMatch.exists)
        capture(app, name: "Bar One breakfast prices")
        app.buttons["Drink guide"].tap()
        XCTAssertTrue(app.staticTexts["Bartender drink guide"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Old Fashioned"].exists)
        XCTAssertTrue(app.staticTexts["2 oz bourbon or rye"].exists)
        capture(app, name: "Bar One bartender instructions")
        let search = app.textFields["Find a drink recipe"]
        XCTAssertTrue(search.exists)
        search.tap()
        search.typeText("pina colada")
        let hideKeyboard = app.buttons["Hide keyboard"]
        if hideKeyboard.exists { hideKeyboard.tap() }
        XCTAssertTrue(app.staticTexts["Piña Colada"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Virgin Piña Colada"].exists)
        XCTAssertTrue(app.staticTexts["2 oz white rum"].isHittable)
        XCTAssertTrue(app.staticTexts.matching(identifier: "1 oz cream of coconut").firstMatch.exists)
        capture(app, name: "Bar One Pina Colada recipe")
        app.buttons["Service"].tap()
        app.buttons["Cocktails"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Old Fashioned", "$12.00")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Margarita", "$10.00")).firstMatch.exists)
        capture(app, name: "Bar One imported live cocktail prices")
    }

    func testRestoreLandscapeOrientation() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ONECLUB_RESTORE_ORIENTATION"] == "landscapeRight", "Run only for an explicit orientation correction.")
        XCUIDevice.shared.orientation = .landscapeRight
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["Connection"].waitForExistence(timeout: 15))
        capture(app, name: "Corrected iPad orientation")
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + " accessibility"
        tree.lifetime = .keepAlways
        add(tree)
    }

    func testPhysicalPracticeRegister() throws {
        continueAfterFailure = true
        let origin = try XCTUnwrap(ProcessInfo.processInfo.environment["ONECLUB_TEST_ORIGIN"])
        XCTAssertTrue(origin.hasPrefix("http://") || origin.hasPrefix("https://"), "Supply the explicit practice server origin.")
        let app = XCUIApplication()
        app.launchArguments = ["-oneclub.serverOrigin", origin]
        addUIInterruptionMonitor(withDescription: "Bar One local network") { alert in
            guard alert.label.contains("Bar One") || alert.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Bar One")).count > 0 else { return false }
            let allow = alert.buttons["Allow"]
            if allow.exists { allow.tap(); return true }
            return false
        }
        app.launch()
        defer {
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "Bar One physical iPad"
            screenshot.lifetime = .keepAlways
            add(screenshot)
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "Bar One accessibility state"
            tree.lifetime = .keepAlways
            add(tree)
        }
        app.tap()
        let loaded = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Sign in", "Bar & kitchen")).firstMatch
        guard loaded.waitForExistence(timeout: 35) else {
            XCTFail("The iPad must load the register or sign-in screen.")
            return
        }
        if app.buttons["Sign in"].exists {
            // A modal sign-in dialog hides the banner from accessibility until
            // sign-in completes. Confirm the fixture operator before its PIN.
            XCTAssertTrue(String(describing: app.otherElements["Register operator"].value).contains("Club Operator"))
            let pin = app.secureTextFields.firstMatch
            XCTAssertTrue(pin.waitForExistence(timeout: 10))
            pin.tap()
            pin.typeText("2468")
            app.buttons["Sign in"].tap()
        }
        let practice = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "PRACTICE MODE")).firstMatch
        XCTAssertTrue(practice.waitForExistence(timeout: 20), "This test must remain in the isolated practice venue.")
        XCTAssertTrue(app.buttons["Bar & kitchen"].waitForExistence(timeout: 20), "Signed-in bar controls must be visible.")
    }
}
