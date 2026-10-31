#if os(macOS)
import AppKit
#endif
import SwiftUI

@main
struct NiaoApp: App {
    @StateObject private var store = ChatStore()
    #if os(iOS)
    @Environment(\.scenePhase) private var scenePhase
    #endif
    var body: some Scene {
        #if os(iOS)
        WindowGroup {
            ChatView(store: store)
                .task { store.start() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Face ID temporarily makes the scene inactive; only background locks it.
            if phase == .background { store.suspend() }
            else if phase == .active { store.resume() }
        }
        #else
        Window("Niao", id: "chat") {
            ChatView(store: store)
                .frame(minWidth: 480, minHeight: 520)
                .task { store.start() }
        }
        .defaultSize(width: 640, height: 740)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("設定…") { store.settingsPresented = true }
                    .keyboardShortcut(",", modifiers: .command)
            }
        }
        Window("利用状況統計", id: "usage-statistics") {
            UsageStatisticsView(store: store)
        }.defaultSize(width: 640, height: 660)
        MenuBarExtra("Niao", systemImage: "bird") {
            MenuContent(store: store)
        }
        #endif
    }
}
#if os(macOS)
struct MenuContent: View {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject var store: ChatStore
    var body: some View {
        Text(store.connection)
        Button("Niao を開く") { show() }
        Button("設定…") { show(); store.settingsPresented = true }
        Button("利用状況統計…") { openWindow(id: "usage-statistics"); NSApplication.shared.activate(ignoringOtherApps: true) }
        Divider()
        Button("Niao を終了") { NSApplication.shared.terminate(nil) }.keyboardShortcut("q")
    }
    private func show() { openWindow(id: "chat"); NSApplication.shared.activate(ignoringOtherApps: true) }
}

#endif
