import XCTest

final class RestaurantSmokeTests: XCTestCase {
    func testStaffSignInScreenLoadsWithoutBackend() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting-reset"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Restaurant team access uses your Cena account."].waitForExistence(timeout: 8))
        let email = app.textFields["Email"]
        let password = app.secureTextFields["Password"]
        let signIn = app.buttons["Sign in"]
        XCTAssertTrue(email.exists)
        XCTAssertTrue(password.exists)
        XCTAssertTrue(signIn.exists)
        XCTAssertFalse(signIn.isEnabled)
        XCTAssertTrue(app.staticTexts["Supabase backend is not configured"].exists)

        email.tap()
        email.typeText("staff@example.com")
        password.tap()
        password.typeText("not-a-real-password")
        XCTAssertEqual(email.value as? String, "staff@example.com")
        XCTAssertFalse(signIn.isEnabled)
    }
}
