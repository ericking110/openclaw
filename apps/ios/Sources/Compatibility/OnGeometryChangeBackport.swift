//
//  OnGeometryChangeBackport.swift
//  Backport for View.onGeometryChange (iOS 17+).
//

import SwiftUI

extension View {
    /// iOS 17+ forwards to the system API; on iOS 15/16 a GeometryReader
    /// background reports the initial value and subsequent layout changes.
    @ViewBuilder
    func backportOnGeometryChange<T: Equatable>(
        for type: T.Type = T.self,
        of transform: @escaping (GeometryProxy) -> T,
        action: @escaping (T) -> Void) -> some View {
        if #available(iOS 17.0, *) {
            self.onGeometryChange(for: type, of: transform, action: action)
        } else {
            self.background(
                GeometryReader { proxy in
                    Color.clear
                        .preference(key: GeometryChangeKey<T>.self,
                                    value: GeometryChangeBox(transform(proxy)))
                }
            )
            .onPreferenceChange(GeometryChangeKey<T>.self) { box in
                if let box { action(box.value) }
            }
        }
    }
}

struct GeometryChangeBox<T>: Equatable {
    let value: T
    static func == (l: Self, r: Self) -> Bool where T: Equatable { l.value == r.value }
}

struct GeometryChangeKey<T: Equatable>: PreferenceKey {
    typealias Value = GeometryChangeBox<T>?
    static var defaultValue: GeometryChangeBox<T>? { nil }
    static func reduce(value: inout GeometryChangeBox<T>?, nextValue: () -> GeometryChangeBox<T>?) {
        value = nextValue() ?? value
    }
}
