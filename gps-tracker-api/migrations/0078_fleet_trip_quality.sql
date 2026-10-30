-- Corrections are a report projection. SIM location/event/annotation rows remain intact.
CREATE TABLE fleet_trip_corrections (
 id BIGSERIAL PRIMARY KEY,
 owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 vehicle_id BIGINT NOT NULL,
 source_device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 binding_id BIGINT NOT NULL REFERENCES fleet_vehicle_bindings(id),
 started_at TIMESTAMPTZ NOT NULL,
 ended_at TIMESTAMPTZ NOT NULL CHECK(ended_at > started_at),
 action TEXT NOT NULL CHECK(action IN ('confirm','adjust','split','merge')),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
 sources JSONB NOT NULL CHECK(jsonb_typeof(sources)='array'),
 outputs JSONB NOT NULL CHECK(jsonb_typeof(outputs)='array'),
 evidence_hash TEXT NOT NULL,
 actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 reverted_at TIMESTAMPTZ,
 reverted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 revert_reason TEXT,
 FOREIGN KEY(vehicle_id,owner_id) REFERENCES fleet_vehicles(id,owner_id) ON DELETE CASCADE,
 EXCLUDE USING gist (int8range(owner_id,owner_id,'[]') WITH &&,
   int8range(source_device_id,source_device_id,'[]') WITH &&,
   tstzrange(started_at,ended_at,'[)') WITH &&) WHERE(reverted_at IS NULL)
);
CREATE INDEX fleet_trip_corrections_vehicle ON fleet_trip_corrections(owner_id,vehicle_id,id);
