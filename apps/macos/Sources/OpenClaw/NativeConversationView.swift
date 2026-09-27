import AppKit
import Observation
import OpenClawChatUI
import OpenClawKit
import SwiftUI
import WebKit

@MainActor
@Observable
final class NativeConversationController {
    let owner: OpenClawWebConversation
    private let viewModel: OpenClawChatViewModel
    private var initialDraft: String?
    private let target: DashboardGatewayTarget
    private let connection: GatewayConnection
    private let ownershipID = UUID()
    private var ownedScopes: Set<OpenClawChatSendOwnership.Scope> = []
    private(set) var navigating = false
    private var isClosed = false
    private var didFallBack = false
    private let outbox: (any OpenClawChatCommandOutbox)?
    private(set) var bridge: NativeConversationBridge?
    private(set) var error: String?
    private var startTask: Task<Void, Never>?
    private var outboxTask: Task<Void, Never>?
    private var nativeOwnershipTask: Task<Void, Never>?
    private var navigationGeneration: UInt64 = 0
    var onTitleChanged: ((String) -> Void)?
    private var visible = false
    private var active = false

    init(
        owner: OpenClawWebConversation,
        viewModel: OpenClawChatViewModel,
        target: DashboardGatewayTarget,
        connection: GatewayConnection,
        outbox: (any OpenClawChatCommandOutbox)?)
    {
        self.owner = owner
        self.viewModel = viewModel
        self.initialDraft = viewModel.input.isEmpty ? nil : viewModel.input
        self.target = target
        self.connection = connection
        self.outbox = outbox
        owner.navigate = { [weak self] context in self?.navigate(context) }
    }

    func start() {
        guard !self.isClosed, self.startTask == nil else { return }
        self.startTask = Task { @MainActor [weak self] in
            guard let self else { return }
            self.viewModel.load()
            await self.viewModel.refreshAgents()
            guard !Task.isCancelled else { return }
            let pendingNativeWork = await self.viewModel.hasPendingNativeConversationWork()
            let reserved = pendingNativeWork ? false : await self.reserveCurrentSession()
            guard !Task.isCancelled else { return }
            if !reserved {
                self.initialDraft = nil
                self.viewModel.setWebConversationMode(.native)
                self.observeOutboxDrain()
                return
            }
            if let bridge = self.bridge {
                guard let route = self.routeURL(baseURL: bridge.document.currentURL) else { return }
                bridge.load(route)
                return
            }
            do {
                let handler = NativeConversationMessageHandler()
                let document = try await DashboardManager.shared
                    .conversationDocument(for: self.target) { controller, url in
                        controller.addScriptMessageHandler(
                            handler,
                            contentWorld: .page,
                            name: NativeConversationContract.handlerName)
                        controller.addUserScript(WKUserScript(
                            source: ControlUIDocumentHost.scopedDashboardScript(
                                NativeConversationContract.hostScript,
                                url: url),
                            injectionTime: .atDocumentStart,
                            forMainFrameOnly: true))
                    }
                guard !Task.isCancelled else { return }
                let bridge = NativeConversationBridge(document: document)
                handler.owner = bridge
                self.bridge = bridge
                bridge.onReady = { [weak self] in
                    guard let self else { return }
                    if self.viewModel.input == self.initialDraft { self.viewModel.input = "" }
                    self.initialDraft = nil
                    self.viewModel.setWebConversationMode(.web)
                    self.present(
                        visible: self.visible,
                        active: self.active)
                    if let context = self.viewModel.webConversationContext { self.navigate(context) }
                }
                bridge.onState = { [weak self] state in
                    guard let self, !self.navigating, self.owner.ownsConversation else { return }
                    if !self.viewModel.matchesWebConversationContext(state.context) {
                        self.adoptWebRoute(state.context)
                        return
                    }
                    self.viewModel.acceptWebConversation(state)
                    self.onTitleChanged?(state.title)
                }
                bridge.onRouteChanged = { [weak self] change in
                    guard let self else { return }
                    self.adoptWebRoute(NativeConversationContext(
                        agentId: change.agentId,
                        sessionKey: change.sessionKey))
                }
                bridge.onOpenDashboard = { [weak self] route in self?.openDashboard(route) ?? false }
                bridge.onDocumentRetired = { [weak self] in self?.owner.state = nil }
                bridge.onUnavailable = { [weak self] availability in
                    guard let self else { return }
                    self.didFallBack = true
                    self.bridge?.close()
                    self.releaseOwnership()
                    self.viewModel.setWebConversationMode(.native)
                    if case let .failed(message) = availability { self.error = message }
                }
                guard let route = self.routeURL(baseURL: document.currentURL) else {
                    self.releaseOwnership()
                    self.viewModel.setWebConversationMode(.native)
                    return
                }
                bridge.load(route)
            } catch {
                guard !Task.isCancelled else { return }
                self.didFallBack = true
                self.releaseOwnership()
                self.error = error.localizedDescription
                self.viewModel.errorText = error.localizedDescription
                self.viewModel.setWebConversationMode(.native)
            }
        }
    }

    private func observeOutboxDrain() {
        guard !self.isClosed else { return }
        self.outboxTask?.cancel()
        self.nativeOwnershipTask?.cancel()
        if let outbox {
            self.outboxTask = Task { [weak self] in
                for await _ in outbox.changes() {
                    guard !Task.isCancelled, let self else { return }
                    await self.reconsiderNativeOwner()
                }
            }
        }
        let changes = self.connection.chatSendOwnership.changes()
        self.nativeOwnershipTask = Task { [weak self] in
            for await _ in changes {
                guard !Task.isCancelled, let self else { return }
                await self.reconsiderNativeOwner()
            }
        }
        Task { await self.reconsiderNativeOwner() }
    }

    private func reconsiderNativeOwner() async {
        guard !self.didFallBack else { return }
        let pending = await self.viewModel.hasPendingNativeConversationWork()
        guard !pending, !Task.isCancelled, !self.isClosed, self.owner.mode == .native else { return }
        guard await self.reserveCurrentSession(), !Task.isCancelled,
              !self.isClosed, self.owner.mode == .native else { return }
        self.viewModel.setWebConversationMode(.probing)
        self.outboxTask?.cancel()
        self.nativeOwnershipTask?.cancel()
        if let bridge = self.bridge, bridge.currentDocumentId != nil,
           let context = self.viewModel.webConversationContext
        {
            self.navigate(context)
        } else {
            self.startTask = nil
            self.start()
        }
    }

    func nativeDraftChanged() {
        guard self.owner.mode == .native, !self.didFallBack else { return }
        Task { await self.reconsiderNativeOwner() }
    }

    private func routeURL(baseURL: URL) -> URL? {
        guard let context = self.viewModel.webConversationContext,
              let path = WebChatRoute.dashboardPath(
                  sessionKey: context.sessionKey,
                  agentID: context.agentId)
        else { return nil }
        return DashboardRouteMap.dashboardURL(
            byAppendingSameAppPath: path,
            search: WebChatRoute.dashboardSearch(draft: self.initialDraft),
            to: baseURL)
    }

    private func navigate(_ context: NativeConversationContext) {
        guard !self.isClosed, !self.didFallBack else { return }
        if self.bridge == nil {
            self.startTask?.cancel()
            self.startTask = nil
            self.viewModel.setWebConversationMode(.probing)
            self.start()
            return
        }
        self.transition(
            to: context,
            notifyWeb: true)
    }

    private func adoptWebRoute(_ context: NativeConversationContext) {
        guard self.owner.ownsConversation else { return }
        self.viewModel.acceptWebRoute(context)
        self.transition(
            to: context,
            notifyWeb: false)
    }

    private func transition(
        to context: NativeConversationContext,
        notifyWeb: Bool)
    {
        guard let bridge, bridge.currentDocumentId != nil else { return }
        self.navigationGeneration &+= 1
        let generation = self.navigationGeneration
        self.owner.state = nil
        self.error = nil
        self.navigating = true
        bridge.document.webView.window?.makeFirstResponder(nil)
        Task { @MainActor [weak self] in
            guard let self else { return }
            let reserved = await self.reserveCurrentSession()
            guard !self.isClosed, generation == self.navigationGeneration else { return }
            guard reserved else {
                self.navigating = false
                // A web-origin route may already have activated this session. Retire
                // its socket/outbox before restoring the pending native work's owner.
                bridge.close()
                self.bridge = nil
                self.startTask = nil
                self.releaseOwnership()
                self.viewModel.setWebConversationMode(.native)
                self.observeOutboxDrain()
                return
            }
            self.viewModel.setWebConversationMode(.web)
            let result = notifyWeb
                ? await bridge.request(.navigate(context))
                : NativeConversationResult(
                    requestId: "",
                    ok: true)
            guard !self.isClosed, generation == self.navigationGeneration,
                  bridge.currentDocumentId != nil else { return }
            self.navigating = !result.ok
            if result.ok, let state = bridge.state, self.viewModel.matchesWebConversationContext(state.context) {
                self.viewModel.acceptWebConversation(state)
                self.onTitleChanged?(state.title)
            }
            if result.ok, self.active { self.focusComposer() }
            if !result.ok {
                self.error = String(localized:
                    "Could not open this conversation. Select another thread or reopen the window.")
            }
        }
    }

    func focusComposer() {
        guard let bridge, bridge.currentDocumentId != nil, self.owner.mode == .web,
              !self.navigating else { return }
        bridge.document.webView.window?.makeFirstResponder(bridge.document.webView)
        Task { _ = await bridge.request(.focusComposer) }
    }

    func present(
        visible: Bool,
        active: Bool)
    {
        self.visible = visible
        self.active = active
        guard let bridge, bridge.currentDocumentId != nil else { return }
        Task { _ = await bridge.request(.presentation(.init(
            visible: visible,
            active: active))) }
    }

    private func openDashboard(_ route: NativeConversationDashboardRoute) -> Bool {
        guard let bridge, let documentId = bridge.currentDocumentId,
              let path = ControlUIDocumentHost.appPath(
                  fromDocumentPath: route.path,
                  baseURL: bridge.document.currentURL),
              route.search.map(DashboardRouteMap.isValidSameAppSearch) != false else { return false }
        let generation = bridge.document.generation
        Task { @MainActor [weak self, weak bridge] in
            guard let self, let bridge else { return }
            await DashboardManager.shared.show(
                atPath: path,
                search: route.search,
                target: self.target)
            {
                !self.isClosed && bridge.currentDocumentId == documentId &&
                    bridge.document.generation == generation && bridge.document.hasCurrentBrowserSession
            }
        }
        return true
    }

    private var nativeInputIsBusy: Bool {
        self.owner.mode == .native && (self.viewModel.hasDraftToSend || self.viewModel.isAttachmentOwnerPinned ||
            self.viewModel.isSending || self.viewModel.isSubmittingDraft)
    }

    private func reserveCurrentSession() async -> Bool {
        guard let context = self.viewModel.webConversationContext else { return false }
        let scope = await self.connection.conversationOwnershipScope(
            sessionKey: context.sessionKey,
            agentID: context.agentId)
        guard !self.isClosed, !self.didFallBack, self.viewModel.webConversationContext == context,
              !self.nativeInputIsBusy else { return false }
        if self.ownedScopes.contains(scope) { return true }
        let ownership = self.connection.chatSendOwnership
        // Each awaiting attempt owns its own claim. A stale completion must not
        // release another attempt's claim for the same conversation.
        let reservation = UUID()
        let accepted: Bool = if let store = self.outbox as? OpenClawChatSQLiteTranscriptCache {
            await store.reserveWebConversation(
                scope: scope,
                owner: reservation,
                ownership: ownership)
        } else {
            ownership.beginWeb(
                scope,
                owner: reservation)
        }
        guard accepted else { return false }
        defer { ownership.endWeb(scope, owner: reservation) }
        guard !self.isClosed, !self.didFallBack, self.viewModel.webConversationContext == context,
              !self.nativeInputIsBusy else { return false }
        // The temporary claim keeps native admission closed across this transfer.
        guard ownership.beginWeb(scope, owner: self.ownershipID) else { return false }
        self.ownedScopes.insert(scope)
        return true
    }

    private func releaseOwnership() {
        for scope in self.ownedScopes {
            self.connection.chatSendOwnership.endWeb(
                scope,
                owner: self.ownershipID)
        }
        self.ownedScopes.removeAll()
    }

    func close() {
        self.isClosed = true
        self.navigationGeneration &+= 1
        self.releaseOwnership()
        self.startTask?.cancel()
        self.outboxTask?.cancel()
        self.nativeOwnershipTask?.cancel()
        self.bridge?.close()
    }
}

struct NativeConversationView: View {
    let controller: NativeConversationController

    var body: some View {
        ZStack {
            if let bridge = self.controller.bridge {
                NativeConversationWebView(bridge: bridge)
                    .opacity(bridge.availability == .ready && !self.controller.navigating ? 1 : 0)
                    .allowsHitTesting(!self.controller.navigating)
            }
            if let error = self.controller.error {
                Text(error).foregroundStyle(.secondary).padding()
            } else if self.controller.bridge?.availability != .ready {
                ProgressView()
            }
        }
        .task { self.controller.start() }
    }
}

private struct NativeConversationWebView: NSViewRepresentable {
    let bridge: NativeConversationBridge

    func makeCoordinator() -> NativeConversationBridge {
        self.bridge
    }

    func makeNSView(context: Context) -> WKWebView {
        context.coordinator.document.webView
    }

    func updateNSView(_: WKWebView, context _: Context) {}
}
