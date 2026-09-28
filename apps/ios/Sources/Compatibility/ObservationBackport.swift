//
//  ObservationBackport.swift
//  Backport helper for withObservationTracking on iOS < 17.
//

import Foundation

/// Runs `apply` once. On iOS 17+ forwards to the real Observation API; on
/// older systems the initial read happens but automatic re-tracking does not.
/// Call sites needing live updates on iOS 15 must additionally subscribe
/// through Combine.
func backportObservationTracking(
    _ apply: () -> Void,
    onChange: @escaping () -> Void) {
    if #available(iOS 17.0, *) {
        withObservationTracking(apply, onChange: onChange)
    } else {
        apply()
    }
}
