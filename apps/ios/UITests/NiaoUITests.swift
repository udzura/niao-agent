import XCTest

final class NiaoUITests: XCTestCase {
    @MainActor func testChatNavigationAndMultilineDraft() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        // Process-only defaults: never unlock a developer's saved connection.
        app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP",
                               "-backendURL", "https://ui-test-\(UUID().uuidString.lowercased()).invalid"]
        app.launch()
        let menu = app.buttons["チャットメニュー"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        let settings = app.buttons["設定"]
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "(-34018)")).firstMatch.exists,
                       "Simulator must be signed so Keychain access is available")
        capture("iPhone-chat")

        app.buttons["会話一覧"].tap()
        XCTAssertTrue(app.navigationBars["会話"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["最終活動から30日で自動削除"].exists)
        XCTAssertTrue(app.switches["アーカイブを表示"].exists)
        capture("iPhone-sessions")
        app.buttons["完了"].tap()

        menu.tap()
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        capture("iPhone-chat-menu")
        app.buttons["利用状況統計を開く"].tap()
        XCTAssertTrue(app.navigationBars["利用状況統計"].waitForExistence(timeout: 5))
        app.segmentedControls.buttons["Workers"].tap()
        XCTAssertTrue(app.staticTexts["Workersの利用状況"].waitForExistence(timeout: 5))
        app.segmentedControls.buttons["ツール"].tap()
        XCTAssertTrue(app.staticTexts["ツール実行の統計"].waitForExistence(timeout: 5))
        capture("iPhone-statistics")
        app.buttons["完了"].tap()

        menu.tap()
        settings.tap()
        XCTAssertTrue(app.textFields["backend-url"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["backend-token"].exists)
        XCTAssertTrue(app.switches["system-notifications-toggle"].exists)
        capture("iPhone-settings")
        app.buttons["キャンセル"].tap()

        let input = app.textFields["message-input"]
        input.tap()
        input.typeText("draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        capture("iPhone-compact-keyboard")
        // Even an empty history is a keyboard-dismiss target. Input taps must
        // keep focus, while history taps dismiss it in both editing modes.
        app.staticTexts["Niao"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "draft")
        app.buttons["Thinkingを調整"].tap()
        XCTAssertTrue(app.sliders["Thinking"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["thinking-model-name"].exists)
        capture("iPhone-thinking-popover")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.3)).tap()

        app.buttons["複数行で入力"].tap()
        let editor = app.textViews["multiline-input"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        editor.typeText("first line\nsecond line")
        XCTAssertEqual(editor.value as? String, "first line\nsecond line")
        capture("iPhone-multiline-keyboard")
        app.staticTexts["Niao"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, "first line\nsecond line")
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
    @MainActor func testSoftwareKeyboardLayout() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP",
                               "-backendURL", "https://ui-test-\(UUID().uuidString.lowercased()).invalid"]
        app.launch()
        let input = app.textFields["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        // Headless runners can expose an off-screen keyboard to accessibility
        // without rendering it. Do not count that as visible-keyboard coverage.
        let visible = NSPredicate { _, _ in
            keyboard.exists && keyboard.frame.height > 200 &&
            keyboard.frame.minY < app.frame.maxY - 200
        }
        let ready = XCTNSPredicateExpectation(predicate: visible, object: keyboard)
        guard XCTWaiter.wait(for: [ready], timeout: 5) == .completed else {
            throw XCTSkip("Software keyboard is off-screen in this simulator; verify on a device or with Simulator's software keyboard enabled.")
        }
        XCTAssertLessThanOrEqual(input.frame.maxY, keyboard.frame.minY + 2)
        XCTAssertGreaterThan(app.scrollViews.firstMatch.frame.height, 200)
        capture("iPhone-visible-keyboard")
    }
    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
