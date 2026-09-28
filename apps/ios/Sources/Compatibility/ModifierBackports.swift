//
//  ModifierBackports.swift
//  Version-gated no-op / visual shims for newer SwiftUI modifiers.
//

import SwiftUI

extension View {
    /// Liquid Glass effect (iOS 26). On older systems render a material background
    /// approximation matching the intended rounded panel.
    @ViewBuilder
    func backportGlassEffect(cornerRadius: CGFloat) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
        } else {
            self.background(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .fill(.ultraThinMaterial))
        }
    }

    /// Sheet sizing (iOS 18+); no-op fallback.
    @ViewBuilder
    func backportPresentationSizing() -> some View {
        if #available(iOS 18.0, *) {
            self.presentationSizing(.fitted)
        } else {
            self
        }
    }

    /// safeAreaPadding (iOS 17+) -> ordinary padding.
    @ViewBuilder
    func backportSafeAreaPadding(_ edges: Edge.Set, _ length: CGFloat) -> some View {
        if #available(iOS 17.0, *) {
            self.safeAreaPadding(edges, length)
        } else {
            self.padding(edges, length)
        }
    }

    /// defaultScrollAnchor (iOS 17+); no-op fallback.
    @ViewBuilder
    func backportDefaultScrollAnchor() -> some View {
        if #available(iOS 17.0, *) {
            self.defaultScrollAnchor(.center)
        } else {
            self
        }
    }

    /// focusEffectDisabled (iOS 17+); no-op fallback.
    @ViewBuilder
    func backportFocusEffectDisabled() -> some View {
        if #available(iOS 18.0, *) {
            self.focusEffectDisabled()
        } else {
            self
        }
    }
}
