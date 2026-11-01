import XCTest
@testable import NiaoCore

final class ThinkingTests: XCTestCase {
    func testModelSettingsRestoreThinkingAndAcceptOlderServers() throws {
        let old = #"{"v":1,"epoch":2,"modelId":"gemma","models":[{"id":"gemma","name":"Gemma"}]}"#
        let legacy = try JSONDecoder().decode(AgentSettings.self, from: Data(old.utf8))
        XCTAssertNil(legacy.serverVersion)
        XCTAssertFalse(legacy.thinkingEnabled)
        XCTAssertNil(legacy.models[0].supportsThinking)
        let current = #"{"v":1,"epoch":2,"modelId":"gemma","thinkingEnabled":true,"serverVersion":"0.1.20261101","models":[{"id":"gemma","name":"Gemma","supportsThinking":true},{"id":"glm","name":"GLM","supportsThinking":false}]}"#
        let settings = try JSONDecoder().decode(AgentSettings.self, from: Data(current.utf8))
        XCTAssertEqual(settings.serverVersion, "0.1.20261101")
        XCTAssertTrue(settings.thinkingEnabled)
        XCTAssertEqual(settings.models.map(\.supportsThinking), [true,false])
        let event = try JSONDecoder().decode(ServerEvent.self, from: Data("{\"v\":1,\"type\":\"settings_updated\",\"settings\":\(current)}".utf8))
        XCTAssertEqual(event.settings?.thinkingEnabled, true)
    }
    func testModelSettingsRequestEncodesEachThinkingModeWithoutALegacyBoolean() throws {
        for mode in ThinkingMode.allCases {
            let request = ModelSettingsUpdate(modelId: "gemma", thinkingMode: mode)
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String:Any])
            XCTAssertEqual(body["modelId"] as? String, "gemma")
            XCTAssertEqual(body["thinkingMode"] as? String, mode.rawValue)
            XCTAssertNil(body["thinkingEnabled"])
        }
    }
    func testAutomaticModeSurvivesSettingsAndHistoryDecoding() throws {
        let settings = #"{"v":1,"epoch":0,"modelId":"gemma","thinkingMode":"auto","thinkingEnabled":false,"models":[]}"#
        let decoded = try JSONDecoder().decode(AgentSettings.self,from:Data(settings.utf8))
        XCTAssertEqual(decoded.thinkingMode, .automatic)
        XCTAssertEqual(decoded.thinkingPolicy, .standard)
        XCTAssertEqual(decoded.thinkingChoice, .automatic)
        let history = "{\"v\":1,\"messages\":[],\"cursor\":0,\"hasMore\":false,\"turns\":[],\"active\":null,\"settings\":\(settings)}"
        XCTAssertEqual(try JSONDecoder().decode(HistoryPage.self,from:Data(history.utf8)).settings?.thinkingMode,.automatic)
    }
    func testComposerPresetsUseDistinctThresholdsAndKeepTheJudgeTimeout() throws {
        let existing = ThinkingPolicy(offThreshold: 0.2, onThreshold: 0.8, ambiguity: "off", timeoutMs: 1500)
        let presets: [(ThinkingChoice, Double, Double)] = [
            (.automaticSelective, 0.65, 0.85), (.automatic, 0.35, 0.65), (.automaticFrequent, 0.15, 0.45)
        ]
        for (choice, off, on) in presets {
            let update = choice.update(using: existing)
            XCTAssertEqual(update.thinkingMode, .automatic)
            let policy = try XCTUnwrap(update.thinkingPolicy)
            XCTAssertEqual(policy.offThreshold, off)
            XCTAssertEqual(policy.onThreshold, on)
            XCTAssertEqual(policy.ambiguity, "on")
            XCTAssertEqual(policy.timeoutMs, 1500)
            XCTAssertEqual(ThinkingChoice.current(mode: .automatic, policy: policy), choice)
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(update)) as? [String: Any])
            XCTAssertNil(body["modelId"]) // A thinking change must not overwrite the model.
            XCTAssertEqual(body["thinkingMode"] as? String, "auto")
        }
        for choice in [ThinkingChoice.on, .off] {
            XCTAssertNil(choice.update(using: existing).thinkingPolicy)
            XCTAssertEqual(ThinkingChoice.current(mode: choice == .on ? .on : .off, policy: existing), choice)
        }
        XCTAssertEqual(ThinkingChoice.current(mode: .automatic, policy: existing), .custom)
        // Model-only changes leave the thinking selection and custom API policy alone.
        let modelOnly = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(ModelSettingsUpdate(modelId: "glm"))) as? [String: Any])
        XCTAssertEqual(Set(modelOnly.keys), ["modelId"])
    }
    func testSavedPresetRestoresThroughSettingsEvents() throws {
        let raw = #"{"v":1,"type":"settings_updated","settings":{"v":1,"epoch":0,"modelId":"gemma","thinkingMode":"auto","thinkingPolicy":{"offThreshold":0.65,"onThreshold":0.85,"ambiguity":"on","timeoutMs":1500},"models":[]}}"#
        let settings = try XCTUnwrap(JSONDecoder().decode(ServerEvent.self, from: Data(raw.utf8)).settings)
        XCTAssertEqual(settings.thinkingChoice, .automaticSelective)
        XCTAssertEqual(settings.thinkingPolicy.timeoutMs, 1500)
        let custom = raw.replacingOccurrences(of: "0.65", with: "0.6")
        XCTAssertEqual(try JSONDecoder().decode(ServerEvent.self, from: Data(custom.utf8)).settings?.thinkingChoice, .custom)
    }
    func testJudgeUsageIsIncludedOnceAndKeepsDurationSeparateFromNeurons() throws {
        let raw = #"{"v":1,"dayStart":"2026-10-29T00:00:00Z","dayEnd":"2026-10-30T00:00:00Z","asOf":"now","account":{"status":"not_configured","neurons":null,"queriedAt":null,"errorCode":null},"local":{"neurons":8.455,"attempts":3,"unmeasuredAttempts":0,"trackingSince":"now","judge":{"neurons":3.455,"attempts":1,"unmeasuredAttempts":0,"calculatedAttempts":1,"totalDurationMs":480,"timedAttempts":1}}}"#
        let usage = try JSONDecoder().decode(UsageSnapshot.self,from:Data(raw.utf8))
        XCTAssertEqual(usage.displayedNeurons,8.455)
        XCTAssertEqual(usage.scopeLabel,"Niao 記録・換算分")
        XCTAssertEqual(usage.local.judge?.totalDurationMs,480)
        let available = raw.replacingOccurrences(of:#""status":"not_configured","neurons":null"#,with:#""status":"available","neurons":10"#)
        let account = try JSONDecoder().decode(UsageSnapshot.self,from:Data(available.utf8))
        XCTAssertEqual(account.displayedNeurons,10) // Account already includes judge usage.
        XCTAssertEqual(account.scopeLabel,"アカウント全体")
    }
    func testLegacyMessagesHaveNoThinkingAndNewHistoryRestoresSegments() throws {
        let legacy = #"{"seq":1,"id":"a","requestId":"r","role":"assistant","content":"answer","createdAt":"now"}"#
        XCTAssertNil(try JSONDecoder().decode(ChatMessage.self, from: Data(legacy.utf8)).thinking)
        let raw = legacy.dropLast() + #", "thinking":[{"generation":0,"text":"before tool\n  whitespace","active":false},{"generation":1,"text":"after tool","active":false}]}"#
        let message = try JSONDecoder().decode(ChatMessage.self, from: Data(raw.utf8))
        XCTAssertEqual(message.content, "answer")
        XCTAssertEqual(message.thinking?.map(\.generation), [0,1])
        XCTAssertEqual(message.thinking?.first?.text, "before tool\n  whitespace")
        let restored = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(restored, message)
    }
    func testStreamingAndHTTPActiveSnapshotsKeepThinkingApartFromAnswer() throws {
        let event = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"v":1,"type":"partial","requestId":"r","text":"answer","thinking":[{"generation":0,"text":"thinking","active":true}]}"#.utf8))
        let partial = PartialMessage(requestId: event.requestId!,text: event.text!,thinking:event.thinking)
        XCTAssertEqual(partial.text, "answer")
        XCTAssertEqual(partial.thinking?.first?.active, true)
        let restored = try JSONDecoder().decode(PartialMessage.self, from: JSONEncoder().encode(partial))
        XCTAssertEqual(restored.thinking, partial.thinking)
        XCTAssertEqual(restored.thinking?.first?.text, "thinking")
    }
}
