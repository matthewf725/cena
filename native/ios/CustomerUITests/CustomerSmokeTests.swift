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
}
