//
//  ScrollBackport.swift
//  Backports for onScrollGeometryChange (iOS 18) and onScrollPhaseChange (iOS 17).
//

import SwiftUI

@available(iOS 15.0, *)
extension View {
    /// iOS 18+ forwards to system API. On older systems automatic scroll-geometry
    /// observation is unavailable; the action never fires (cosmetic auto-scroll
    /// behaviour only; ScrollViewReader programmatic scrolling still works).
    @ViewBuilder
    func backportOnScrollGeometryChange<T: Equatable>(
        for type: T.Type = T.self,
        of transform: @escaping (ScrollGeometry) -> T,
        action: @escaping (T, T) -> Void) -> some View {
        if #available(iOS 18.0, *) {
            self.onScrollGeometryChange(for: type, of: transform) { old, new in
                action(old, new)
            }
        } else {
            self
        }
    }

    /// iOS 17+ forwards to system API; no-op on iOS 15/16.
    @ViewBuilder
    func backportOnScrollPhaseChange(action: @escaping (ScrollPhase, ScrollPhase) -> Void) -> some View {
        if #available(iOS 17.0, *) {
            self.onScrollPhaseChange { oldPhase, newPhase in
                action(oldPhase, newPhase)
            }
        } else {
            self
        }
    }
}
