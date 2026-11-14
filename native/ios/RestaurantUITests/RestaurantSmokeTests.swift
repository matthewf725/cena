import XCTest

final class RestaurantSmokeTests: XCTestCase {
    func testStaffSignInScreenLoadsWithoutBackend() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting-reset"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Restaurant team access uses your Cena account."].waitForExistence(timeout: 8))
        XCTAssertTrue(app.textFields["Email"].exists)
        XCTAssertTrue(app.secureTextFields["Password"].exists)
        XCTAssertTrue(app.buttons["Sign in"].exists)
        XCTAssertTrue(app.staticTexts["Supabase backend is not configured"].exists)
    }
}
