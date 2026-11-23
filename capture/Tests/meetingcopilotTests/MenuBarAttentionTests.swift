import Foundation
import Testing

@testable import meetingcopilot

/// MEETONTRACK-189 P2-21: delivery and capture problems reach the menu bar,
/// which needs no notification permission.
@MainActor
struct MenuBarAttentionTests {
    @Test("Undelivered reports and stuck recordings make one line; a clean health makes none")
    func deliveryLine() {
        #expect(DeliveryAttention.line(delivery: ["undelivered": [], "stuck_recordings": []]) == nil)
        #expect(DeliveryAttention.line(delivery: [:]) == nil)
        let two = DeliveryAttention.line(delivery: [
            "undelivered": [["meeting_id": "a"], ["meeting_id": "b"]],
        ])
        #expect(two?.contains("2") == true)
        #expect(DeliveryAttention.line(delivery: ["stuck_recordings": [["reason": "dead"]]]) != nil)
    }

    @Test("A problem turns the idle icon into an alert and puts its line on top of the menu")
    func menuShowsAttention() {
        let menu = MenuBarController(visible: true)
        defer { menu.setVisible(false) }
        menu.updateAttention(["Report not sent"])
        #expect(menu.offeredItemTitles.contains { $0.contains("Report not sent") })
        #expect(menu.statusItemTitle.contains("!"))

        menu.updateAttention([])
        #expect(!menu.offeredItemTitles.contains { $0.contains("Report not sent") })
        #expect(!menu.statusItemTitle.contains("!"))
    }
}
