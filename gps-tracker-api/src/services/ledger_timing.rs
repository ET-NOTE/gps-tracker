//! Bounded metadata only: no SQL errors, bind values, identities or paths.
//! Unfinished includes errors AND cancellation, not proof a COMMIT failed.
use std::time::Instant;

pub(super) struct Timing {
    operation: &'static str,
    phase: &'static str,
    started: Instant,
    phase_started: Instant,
    complete: bool,
}
impl Timing {
    pub(super) fn new(operation: &'static str, phase: &'static str) -> Self {
        let now = Instant::now();
        Self {
            operation,
            phase,
            started: now,
            phase_started: now,
            complete: false,
        }
    }
    fn record(&self, outcome: &'static str) {
        let phase_ms = self.phase_started.elapsed().as_millis() as u64;
        let total_ms = self.started.elapsed().as_millis() as u64;
        if outcome != "completed" || phase_ms >= 250 {
            tracing::warn!(target: "gps_ledger_timing", operation = self.operation,
                phase = self.phase, outcome, phase_ms, total_ms, "access ledger timing");
        } else {
            tracing::debug!(target: "gps_ledger_timing", operation = self.operation,
                phase = self.phase, outcome, phase_ms, total_ms, "access ledger timing");
        }
    }
    pub(super) fn next(&mut self, phase: &'static str) {
        self.record("completed");
        self.phase = phase;
        self.phase_started = Instant::now();
    }
    pub(super) fn finish(mut self) {
        self.record("completed");
        self.complete = true;
    }
}
impl Drop for Timing {
    fn drop(&mut self) {
        if !self.complete {
            self.record("error_or_cancelled");
        }
    }
}
