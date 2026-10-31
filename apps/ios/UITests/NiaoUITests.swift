import XCTest

final class NiaoUITests: XCTestCase {
    @MainActor func testChatNavigationAndMultilineDraft() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        // Process-only defaults: never unlock a developer's saved connection.
        app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP",
                               "-backendURL", "https://ui-test-\(UUID().uuidString.lowercased()).invalid"]
        app.launch()
        let settings = app.buttons["設定"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "(-34018)")).firstMatch.exists,
                       "Simulator must be signed so Keychain access is available")
        capture("iPhone-chat")

        app.buttons["利用状況統計を開く"].tap()
        XCTAssertTrue(app.navigationBars["利用状況統計"].waitForExistence(timeout: 5))
        app.segmentedControls.buttons["Workers"].tap()
        XCTAssertTrue(app.staticTexts["Workersの利用状況"].waitForExistence(timeout: 5))
        app.segmentedControls.buttons["ツール"].tap()
        XCTAssertTrue(app.staticTexts["ツール実行の統計"].waitForExistence(timeout: 5))
        capture("iPhone-statistics")
        app.buttons["完了"].tap()

        settings.tap()
        XCTAssertTrue(app.textFields["backend-url"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["backend-token"].exists)
        capture("iPhone-settings")
        app.buttons["キャンセル"].tap()

        app.buttons["複数行で入力"].tap()
        let editor = app.textViews["multiline-input"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("first line\nsecond line")
        XCTAssertEqual(editor.value as? String, "first line\nsecond line")
        capture("iPhone-multiline-keyboard")
        app.buttons["入力欄を縮める"].tap()
        // A single-line UITextField displays line breaks as spaces. The full
        // draft must still be intact when returning to the multiline editor.
        XCTAssertEqual(app.textFields["message-input"].value as? String, "first line second line")
        app.buttons["複数行で入力"].tap()
        XCTAssertEqual(editor.value as? String, "first line\nsecond line")

        // Background suspends the socket; returning must preserve the draft and UI.
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, "first line\nsecond line")
    }
    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
