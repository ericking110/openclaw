//
//  ContentUnavailableViewBackport.swift
//  iOS 15 fallback for SwiftUI ContentUnavailableView (iOS 17+).
//

import SwiftUI

struct BackportContentUnavailableView: View {
    let title: LocalizedStringKey
    let systemImage: String
    var description: Text?

    init(_ title: LocalizedStringKey, systemImage: String, description: Text? = nil) {
        self.title = title
        self.systemImage = systemImage
        self.description = description
    }

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 44))
                .foregroundColor(.secondary)
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
            if let description {
                description
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Usage: `contentUnavailableView(...)` resolves to the system view on iOS 17+
/// and the backport on older systems.
@ViewBuilder
func contentUnavailableView(
    _ title: LocalizedStringKey,
    systemImage: String,
    description: Text? = nil) -> some View {
    if #available(iOS 17.0, *) {
        ContentUnavailableView(title, systemImage: systemImage, description: description)
    } else {
        BackportContentUnavailableView(title, systemImage: systemImage, description: description)
    }
}
