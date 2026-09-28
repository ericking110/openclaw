//
//  SymbolReplaceTransition.swift
//  Backport for .contentTransition(.symbolEffect(.replace)) (iOS 17+).
//

import SwiftUI

struct SymbolReplaceTransition: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.contentTransition(.symbolEffect(.replace))
        } else {
            content
        }
    }
}
