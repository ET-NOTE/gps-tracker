//! Opt-in, fixed numeric ingest stages. Never log identity, payload, SQL or keys.
use std::time::Instant;

#[derive(Clone, Copy, Debug)]
#[repr(usize)]
pub enum Phase {
    Admission,
    Parse,
    PoolBegin,
    Auth,
    HardwareLock,
    SimLock,
    DeviceLock,
    Privacy,
    Collection,
    Metadata,
    Batch,
    Store,
    Publish,
    Geofence,
    Lifecycle,
    Command,
    Binding,
    Sign,
    Commit,
    Done,
}

pub struct IngestTiming {
    phase: Phase,
    since: Instant,
    elapsed: [f64; 20],
    completed: bool,
}

impl IngestTiming {
    pub fn new() -> Self {
        Self {
            phase: Phase::Admission,
            since: Instant::now(),
            elapsed: [0.0; 20],
            completed: false,
        }
    }

    pub fn advance(&mut self, phase: Phase) {
        let now = Instant::now();
        self.elapsed[self.phase as usize] += (now - self.since).as_secs_f64() * 1000.0;
        self.since = now;
        self.phase = phase;
    }

    pub fn complete(&mut self) {
        self.advance(Phase::Done);
        self.completed = true;
    }
}

impl Drop for IngestTiming {
    fn drop(&mut self) {
        let last_phase = self.phase;
        self.advance(Phase::Done);
        let e = &self.elapsed;
        // Each stage includes await/scheduling time. PoolBegin includes BEGIN;
        // Store includes triggers and autocommit, not just SQL execution. This
        // records partial failed/cancelled work without inventing a success.
        tracing::debug!(target: "gps_ingest_timing", completed=self.completed, ?last_phase,
            total_ms=e.iter().sum::<f64>(), admission_ms=e[0], parse_ms=e[1],
            pool_begin_ms=e[2], auth_ms=e[3], hardware_lock_ms=e[4], sim_lock_ms=e[5],
            device_lock_ms=e[6], privacy_ms=e[7], collection_ms=e[8], metadata_ms=e[9],
            batch_ms=e[10], store_ms=e[11], publish_ms=e[12], geofence_ms=e[13],
            lifecycle_ms=e[14], command_ms=e[15], binding_ms=e[16], sign_ms=e[17],
            commit_ms=e[18], "device ingest phases");
    }
}
