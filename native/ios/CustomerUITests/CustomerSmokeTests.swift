import XCTest

final class CustomerSmokeTests: XCTestCase {
    func testGuestCanBrowseAndOpenEmptyBagOffline() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting-reset"]
        app.launch()

        XCTAssertTrue(app.staticTexts["customer.home.title"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Recents"].exists)
        XCTAssertTrue(app.staticTexts["Recent meal kits"].exists)

        let bagTab = app.buttons["Bag"]
        XCTAssertTrue(bagTab.waitForExistence(timeout: 5))
        bagTab.tap()
        XCTAssertTrue(app.staticTexts["Your bag is empty"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Explore kitchens"].exists)
    }

    func testGuestCanOpenProfileAndPrepareEmailSignInOffline() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting-reset"]
        app.launch()

        XCTAssertTrue(app.staticTexts["customer.home.title"].waitForExistence(timeout: 8))
        let profileButton = app.buttons["customer.profile"]
        XCTAssertTrue(profileButton.waitForExistence(timeout: 5))
        profileButton.tap()

        XCTAssertTrue(app.staticTexts["Your Cena account"].waitForExistence(timeout: 5))
        let sendCode = app.buttons["Send sign-in code"]
        XCTAssertTrue(sendCode.exists)
        XCTAssertFalse(sendCode.isEnabled)

        let email = app.textFields["Email address"]
        XCTAssertTrue(email.exists)
        email.tap()
        email.typeText("qa@example.com")
        XCTAssertTrue(sendCode.isEnabled)
    }
}
