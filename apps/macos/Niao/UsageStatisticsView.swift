import SwiftUI

struct UsageStatisticsView: View {
    @ObservedObject var store: ChatStore
    @State private var selection = "neurons"
    @State private var toolSelection = "current"
    var body: some View {
        VStack(spacing: 0) {
            Picker("統計の種類", selection: $selection) {
                Text("Neurons").tag("neurons")
                Text("Workers").tag("workers")
                Text("ツール").tag("tools")
            }.pickerStyle(.segmented).labelsHidden().padding(.horizontal, 24).padding(.top, 20)
            if selection == "neurons" { NeuronStatisticsView(store: store) }
            else if selection == "workers" { PlatformStatisticsView(store: store) }
            else { ToolStatisticsView(store: store, selection: $toolSelection) }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 520)
        #endif
    }
}
