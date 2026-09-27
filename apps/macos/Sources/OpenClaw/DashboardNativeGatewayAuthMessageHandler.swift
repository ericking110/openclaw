import Foundation
import WebKit

@MainActor
final class DashboardNativeGatewayAuthMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "OpenClawNativeGatewayAuth"
    weak var owner: DashboardWindowController?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard message.name == Self.name, let owner,
              message.webView === owner.webView, message.frameInfo.isMainFrame,
              DashboardWindowController.isTrustedLinkSource(
                  message.frameInfo.request.url, dashboardURL: owner.currentURL),
              let request = DashboardNativeGatewayAuthRequest(message.body),
              let provider = owner.nativeGatewayAuthProvider,
              owner.canUseNativeGatewayAuth(sourceID: owner.notificationSourceID)
        else {
            replyHandler(nil, "Native gateway authentication is unavailable for this document.")
            return
        }
        let sourceID = owner.notificationSourceID
        let providerRevision = owner.nativeGatewayAuthRevision
        Task { @MainActor [weak owner] in
            do {
                let response = try await provider(request.nonce, request.signedAt)
                let result = try JSONSerialization.jsonObject(with: response.json)
                guard let owner, owner.canUseNativeGatewayAuth(sourceID: sourceID),
                      owner.nativeGatewayAuthRevision == providerRevision,
                      response.isCurrent()
                else { throw CancellationError() }
                replyHandler(["id": request.id, "result": result], nil)
            } catch {
                replyHandler(["id": request.id, "error": "The native gateway connection is no longer current."], nil)
            }
        }
    }
}

extension DashboardWindowController {
    func canUseNativeGatewayAuth(sourceID: String) -> Bool {
        !Task.isCancelled && self.auth.usesNativeDevice && self.notificationSourceID == sourceID &&
            self.hasRetainedWindow && self.hasCurrentBrowserSession && !self.isShowingFailurePage &&
            Self.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
    }
}
