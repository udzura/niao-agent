import Foundation

struct ToolCallToast: Identifiable {
    let id = UUID()
    let name: String
    let count: Int
    let expiresAt: Date
}
struct ToolCallToastState {
    private(set) var notice: ToolCallToast?
    mutating func show(name: String, at date: Date = Date()) {
        let previous = notice
        let count: Int
        if let previous, previous.name == name, previous.expiresAt > date { count = previous.count + 1 }
        else { count = 1 }
        notice = ToolCallToast(name: name, count: count, expiresAt: date.addingTimeInterval(3.5))
    }
    mutating func dismiss(id: UUID) {
        // A cancelled/late timer from the previous call cannot clear a newer toast.
        if notice?.id == id { notice = nil }
    }
    mutating func clear() { notice = nil }
}
