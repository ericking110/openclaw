import AppKit
import ConcurrencyExtras
import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@MainActor
func waitForNativeDashboardDocument(_ controller: DashboardWindowController) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline {
        if controller.webView.url == controller.currentURL,
           await (try? controller.webView.evaluateJavaScript("document.readyState === 'complete'")) as? Bool == true
        { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    throw URLError(.timedOut)
}

@MainActor
func dashboardNativeAuthSnapshot(_ controller: DashboardWindowController) async throws -> [String: Any] {
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline {
        if let value = try? await controller.webView.evaluateJavaScript(
            "document.readyState === 'complete' ? window.__OPENCLAW_NATIVE_CONTROL_AUTH__ : null") as? [String: Any]
        {
            return value
        }
        try await Task.sleep(for: .milliseconds(10))
    }
    throw URLError(.timedOut)
}

@Suite(.serialized)
@MainActor
struct DashboardNativeGatewayAuthBridgeTests {
    @Test(arguments: ["subframe", "untrusted-path", "browser-identity"])
    func `untrusted frames and browser identity documents cannot request native credentials`(
        _ source: String) async throws
    {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start(
            contentSecurityPolicy: "default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let controller = DashboardWindowController(
            url: server.url("/control/"),
            auth: source == "browser-identity"
                ? .browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
                : .nativeDevice(gatewayUrl: server.websocketURL().absoluteString, token: "secret", password: nil),
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let calls = LockIsolated(0)
        controller.nativeGatewayAuthProvider = { _, _ in
            calls.withValue { $0 += 1 }
            throw CancellationError()
        }
        controller.show()
        try await waitForNativeDashboardDocument(controller)
        let request = """
        window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
          id:'request', nonce:'challenge', signedAt:Date.now()
        }).then(value => { parent.nativeReply = value; },
                error => { parent.nativeReply = {rejected:true}; });
        """
        if source == "subframe" {
            _ = try await controller.webView.callAsyncJavaScript("""
            const frame = document.createElement('iframe');
            frame.srcdoc = '<html><body><script>' + request + '</script></body></html>';
            document.body.append(frame);
            """, arguments: ["request": request], in: nil, contentWorld: .page)
        } else {
            if source == "untrusted-path" {
                _ = try await controller.webView.evaluateJavaScript("history.pushState({}, '', '/outside')")
            }
            _ = try await controller.webView.evaluateJavaScript(request + "null;")
        }
        var reply: [String: Any]?
        let deadline = ContinuousClock.now + .seconds(5)
        while reply == nil, ContinuousClock.now < deadline {
            reply = try await controller.webView.evaluateJavaScript("window.nativeReply") as? [String: Any]
            if reply == nil { try await Task.sleep(for: .milliseconds(10)) }
        }
        #expect(try #require(reply)["rejected"] as? Bool == true)
        #expect(calls.value == 0)
    }

    @Test(arguments: ["current", "document", "provider", "socket", "browser-identity"])
    func `WK challenge replies are owned by the native socket and current dashboard document`(
        _ transition: String) async throws
    {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let controller = DashboardWindowController(
            url: server.url("/control/"),
            auth: .nativeDevice(
                gatewayUrl: server.websocketURL("/control/").absoluteString,
                token: "must-not-be-injected", password: "must-not-be-injected-either"),
            websiteDataStore: .nonPersistent(), windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let requested = AsyncTestGate()
        let release = AsyncTestGate()
        defer { release.open() }
        let current = LockIsolated(true)
        controller.nativeGatewayAuthProvider = { nonce, signedAt in
            #expect(nonce == "challenge")
            #expect(signedAt > 0)
            requested.open()
            await release.wait()
            return DashboardNativeGatewayAuth(
                json: Data(#"{"auth":{"deviceToken":"native-grant"},"scopes":["operator.read"]}"#.utf8),
                isCurrent: { current.value })
        }
        controller.show()
        let bootstrap = try await dashboardNativeAuthSnapshot(controller)
        #expect(bootstrap["nativeConnectAuth"] as? Bool == true)
        #expect(bootstrap["token"] is NSNull)
        #expect(bootstrap["password"] is NSNull)
        #expect(controller.currentURL.fragment == nil)
        _ = try await controller.webView.evaluateJavaScript("""
        window.nativeReply = null;
        window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
          id: 'request', nonce: 'challenge', signedAt: Date.now()
        }).then(value => { window.nativeReply = value; },
                error => { window.nativeReply = {error: String(error)}; });
        null;
        """)
        try await AsyncTimeout.withTimeout(
            seconds: 5, onTimeout: { URLError(.timedOut) }, operation: { await requested.wait() })
        switch transition {
        case "document": controller.webView(controller.webView, didCommit: nil)
        case "provider": controller.nativeGatewayAuthProvider = nil
        case "socket": current.setValue(false)
        case "browser-identity": controller.auth = .browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
        default: break
        }
        release.open()
        let deadline = ContinuousClock.now + .seconds(5)
        var reply: [String: Any]?
        while reply == nil, ContinuousClock.now < deadline {
            reply = try await controller.webView.evaluateJavaScript("window.nativeReply") as? [String: Any]
            if reply == nil { try await Task.sleep(for: .milliseconds(10)) }
        }
        let received = try #require(reply)
        if transition == "current" {
            let result = try #require(received["result"] as? [String: Any])
            #expect((result["auth"] as? [String: String])?["deviceToken"] == "native-grant")
            #expect(received["id"] as? String == "request")
        } else {
            #expect(received["error"] as? String != nil)
            #expect(received["result"] == nil)
        }
    }
}
