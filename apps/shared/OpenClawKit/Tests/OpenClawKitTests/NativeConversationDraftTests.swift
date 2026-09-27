import OpenClawChatUI
import OpenClawKit
import Testing

struct NativeConversationDraftTests {
    @Test func `startup navigation cannot move an initial draft into another conversation`() {
        let origin = NativeConversationContext(agentId: "research", sessionKey: "agent:research:thread-a")
        let draft = OpenClawWebConversation.InitialDraft(context: origin, text: "Only for A")
        let otherThread = NativeConversationContext(agentId: "research", sessionKey: "agent:research:thread-b")
        #expect(draft.text(for: otherThread) == nil)
        #expect(draft.text(for: origin) == "Only for A")
    }

    @Test func `equal unqualified keys on different agents do not share a startup draft`() {
        let origin = NativeConversationContext(agentId: "research", sessionKey: "global")
        let draft = OpenClawWebConversation.InitialDraft(context: origin, text: "Research draft")
        #expect(draft.text(for: .init(agentId: "main", sessionKey: "global")) == nil)
        #expect(draft.text(for: origin) == "Research draft")
    }
}
