//
//  ContentUnavailableViewBuilderBackport.swift
//  Builder-based fallback for ContentUnavailableView (iOS 17+).
//

import SwiftUI

struct BackportContentUnavailableView<Label: View, Description: View, Actions: View>: View {
    @ViewBuilder var labelContent: Label
    @ViewBuilder var descriptionContent: Description
    @ViewBuilder var actionsContent: Actions

    init(@ViewBuilder label: () -> Label,
         @ViewBuilder description: () -> Description,
         @ViewBuilder actions: () -> Actions) {
        self.labelContent = label()
        self.descriptionContent = description()
        self.actionsContent = actions()
    }

    var body: some View {
        VStack(spacing: 10) {
            labelContent
            descriptionContent
            actionsContent
        }
        .multilineTextAlignment(.center)
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension View {
    /// No-op on iOS 17; provided so call sites stay uniform.
}
