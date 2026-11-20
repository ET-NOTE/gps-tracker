//! Executes the actual worker against a disposable schema112 DB, with the normal
//! restricted runtime grants. No production account, device or key is accepted.
use super::*;
use sqlx::postgres::PgPoolOptions;

const KEYS: &str =
    r#"{"active":"repair113","keys":{"repair113":"YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="}}"#;

async fn pool(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(5)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SELECT set_config('gps.storage_keys',$1,false)")
                    .bind(KEYS)
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("SET jit=off").execute(conn).await?;
                Ok(())
            })
        })
        .connect(url)
        .await
        .unwrap()
}

async fn device(db: &PgPool, uid: i64) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES($1,$2,'') RETURNING id",
    )
    .bind(uid)
    .bind(uuid::Uuid::new_v4().to_string())
    .fetch_one(db)
    .await
    .unwrap()
}

async fn count(db: &PgPool, did: i64, table: &str) -> i64 {
    assert!(matches!(table, "daily_stats" | "stats_rebuild_queue"));
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE device_id=$1"))
        .bind(did)
        .fetch_one(db)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires dedicated repair113 Docker DB and restricted runtime"]
async fn missing_daily_repair113() {
    let url = std::env::var("LEDGER_TEST_DATABASE_URL").unwrap();
    let runtime = std::env::var("STATS_TEST_RUNTIME_URL").unwrap();
    assert!(url.contains("closure-test-only@") && url.ends_with("/gps_closure_test"));
    assert!(runtime.contains("gps_runtime:") && runtime.ends_with("/gps_closure_test"));
    let admin = pool(&url).await;
    let db = pool(&runtime).await;
    crate::db::verify_runtime(&db).await.unwrap();
    super::super::privacy_lifecycle::start(&runtime, db.clone())
        .await
        .unwrap();
    let u1: i64 = sqlx::query_scalar("INSERT INTO users(email,password_hash,phone) VALUES($1,'no-login',gen_random_uuid()::text) RETURNING id")
        .bind(format!("repair113-{}@example.invalid",uuid::Uuid::new_v4())).fetch_one(&admin).await.unwrap();
    let u2: i64 = sqlx::query_scalar("INSERT INTO users(email,password_hash,phone) VALUES($1,'no-login',gen_random_uuid()::text) RETURNING id")
        .bind(format!("repair113-{}@example.invalid",uuid::Uuid::new_v4())).fetch_one(&admin).await.unwrap();

    for encrypted in [false, true] {
        sqlx::query("UPDATE location_storage_policy SET enabled=$1")
            .bind(encrypted)
            .execute(&admin)
            .await
            .unwrap();
        let did = device(&db, u1).await;
        // 31 actual KST days, three points/day. The first 3 days already exist.
        sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) SELECT $1,$2,'2026-10-01 00:00+09'::timestamptz+d*interval '1 day'+p*interval '1 minute','l80',true,37+p*0.001,127 FROM generate_series(0,30) d CROSS JOIN generate_series(0,2) p")
            .bind(did).bind(u1).execute(&db).await.unwrap();
        let first = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        for day in 0..3 {
            aggregate_one(&db, did, first + chrono::Duration::days(day))
                .await
                .unwrap();
        }
        let untouched: DateTime<Utc> = sqlx::query_scalar(
            "SELECT updated_at FROM daily_stats WHERE device_id=$1 ORDER BY date LIMIT 1",
        )
        .bind(did)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(discover_page(&db, did, None).await.unwrap().is_none());
        assert_eq!(count(&db, did, "stats_rebuild_queue").await, 28);
        // Commit one job then discard all discovery state: identical durable boundary to a restart.
        let next = first + chrono::Duration::days(3);
        aggregate_one(&db, did, next).await.unwrap();
        sqlx::query("DELETE FROM stats_rebuild_queue WHERE device_id=$1 AND date=$2")
            .bind(did)
            .bind(next)
            .execute(&db)
            .await
            .unwrap();
        discover_page(&db, did, None).await.unwrap();
        assert_eq!(count(&db, did, "stats_rebuild_queue").await, 27);
        process_queue(&db).await.unwrap();
        assert_eq!(count(&db, did, "daily_stats").await, 31);
        assert_eq!(count(&db, did, "stats_rebuild_queue").await, 0);
        let result: (i64,i32,i32,f64) = sqlx::query_as("SELECT sum(fix_count)::bigint,min(fix_count),max(fix_count),min(distance_m) FROM daily_stats WHERE device_id=$1").bind(did).fetch_one(&db).await.unwrap();
        assert_eq!((result.0, result.1, result.2), (93, 3, 3));
        assert!(result.3 > 220.0 && result.3 < 225.0);
        let unchanged: DateTime<Utc> = sqlx::query_scalar(
            "SELECT updated_at FROM daily_stats WHERE device_id=$1 ORDER BY date LIMIT 1",
        )
        .bind(did)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unchanged, untouched);
        let sealed: bool = sqlx::query_scalar("SELECT bool_and(lat IS NULL AND lat_sealed IS NOT NULL) FROM location_records WHERE device_id=$1").bind(did).fetch_one(&admin).await.unwrap();
        assert_eq!(sealed, encrypted);
        println!("PASS partial31 restart/durable/metrics/no-rewrite encrypted={encrypted}");

        let boundary = device(&db, u1).await;
        sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) SELECT $1,$2,'2026-09-01 00:00+09'::timestamptz+i*interval '1 second','l80',true,37,127 FROM generate_series(0,999) i")
            .bind(boundary).bind(u1).execute(&db).await.unwrap();
        // The last anchor has a second source, whose batch crosses the KST day boundary.
        sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb) VALUES($1,$2,'2026-09-01 00:16:39+09','phone',true,37,127,'[{\"at_ms\":0,\"lat\":37,\"lng\":127},{\"at_ms\":86400000,\"lat\":37.001,\"lng\":127}]')")
            .bind(boundary).bind(u1).execute(&db).await.unwrap();
        let cursor = discover_page(&db, boundary, None).await.unwrap().unwrap();
        assert_eq!(count(&db, boundary, "stats_rebuild_queue").await, 1);
        assert!(discover_page(&db, boundary, Some(&cursor))
            .await
            .unwrap()
            .is_none());
        assert_eq!(count(&db, boundary, "stats_rebuild_queue").await, 2);
        process_queue(&db).await.unwrap();
        let pts: i64 =
            sqlx::query_scalar("SELECT sum(fix_count)::bigint FROM daily_stats WHERE device_id=$1")
                .bind(boundary)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(pts, 1001);
        println!("PASS bounded1000/source-tie/KST-batch encrypted={encrypted}");

        // Reusing a SIM/device row with a new owner resets the scan cursor; old-owner data stays excluded.
        sqlx::query("UPDATE devices SET owner_id=$2 WHERE id=$1")
            .bind(boundary)
            .bind(u2)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES($1,$2,'2026-08-01 00:00+09','l80',true,38,128)")
            .bind(boundary).bind(u2).execute(&db).await.unwrap();
        discover_page(&db, boundary, Some(&cursor)).await.unwrap();
        assert_eq!(count(&db, boundary, "stats_rebuild_queue").await, 1);
        process_queue(&db).await.unwrap();
        let owner_count: i64 = sqlx::query_scalar(
            "SELECT sum(fix_count)::bigint FROM daily_stats WHERE device_id=$1 AND user_id=$2",
        )
        .bind(boundary)
        .bind(u2)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(owner_count, 1);
        sqlx::query("UPDATE devices SET owner_id=NULL WHERE id=$1")
            .bind(boundary)
            .execute(&db)
            .await
            .unwrap();
        let before = count(&db, boundary, "daily_stats").await;
        aggregate_one(&db, boundary, first).await.unwrap();
        assert_eq!(count(&db, boundary, "daily_stats").await, before);
        println!("PASS owner-change/unlinked/no-cross-owner encrypted={encrypted}");
    }

    let paused = device(&db, u1).await;
    sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES($1,$2,'2026-07-01','l80',true,37,127)").bind(paused).bind(u1).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO privacy_processing_controls(user_id,use_paused) VALUES($1,true)")
        .bind(u1)
        .execute(&db)
        .await
        .unwrap();
    assert!(discover_page(&db, paused, None).await.is_err());
    assert_eq!(count(&db, paused, "stats_rebuild_queue").await, 0);
    sqlx::query("INSERT INTO stats_rebuild_queue(device_id,date,generation,attempts) VALUES($1,'2026-07-01',9,2)").bind(paused).execute(&db).await.unwrap();
    process_queue(&db).await.unwrap();
    let backoff: (i64,i32,bool) = sqlx::query_as("SELECT generation,attempts,next_attempt_at>now() FROM stats_rebuild_queue WHERE device_id=$1").bind(paused).fetch_one(&db).await.unwrap();
    assert_eq!(backoff, (9, 3, true));
    assert_eq!(count(&db, paused, "daily_stats").await, 0);
    sqlx::query("UPDATE privacy_processing_controls SET use_paused=false WHERE user_id=$1")
        .bind(u1)
        .execute(&db)
        .await
        .unwrap();
    discover_page(&db, paused, None).await.unwrap();
    let preserved: (i64,i32,bool) = sqlx::query_as("SELECT generation,attempts,next_attempt_at>now() FROM stats_rebuild_queue WHERE device_id=$1").bind(paused).fetch_one(&db).await.unwrap();
    assert_eq!(preserved, backoff);
    sqlx::query("UPDATE stats_rebuild_queue SET next_attempt_at=now() WHERE device_id=$1")
        .bind(paused)
        .execute(&db)
        .await
        .unwrap();
    process_queue(&db).await.unwrap();
    assert_eq!(count(&db, paused, "daily_stats").await, 1);
    println!("PASS use-pause/resume/no-zero/backoff-preserved");

    // Hold a device row: page times out and later devices must still be discovered.
    let blocked = device(&db, u2).await;
    let mut lock = db.begin().await.unwrap();
    sqlx::query("SELECT id FROM devices WHERE id=$1 FOR UPDATE")
        .bind(blocked)
        .execute(&mut *lock)
        .await
        .unwrap();
    assert!(discover_page(&db, blocked, None).await.is_err());
    let mut targets = Vec::new();
    for _ in 0..13 {
        let d = device(&db, u2).await;
        targets.push(d);
        sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES($1,$2,'2026-06-01','l80',true,37,127)").bind(d).bind(u2).execute(&db).await.unwrap();
    }
    let mut scan = RepairScan {
        after_device: blocked - 1,
        ..Default::default()
    };
    discover_missing(&db, &mut scan).await.unwrap();
    assert_eq!(scan.after_device, targets[8]);
    assert_eq!(
        count(&db, *targets.last().unwrap(), "stats_rebuild_queue").await,
        0
    );
    discover_missing(&db, &mut scan).await.unwrap();
    assert_eq!(
        count(&db, *targets.last().unwrap(), "stats_rebuild_queue").await,
        1
    );
    lock.rollback().await.unwrap();
    process_queue(&db).await.unwrap();
    println!("PASS lock-timeout/device-rotation/no-starvation");

    // New ingestion invalidates a job while its statistic is committed. The old
    // generation must not acknowledge the newer durable work item.
    let racing = device(&db, u2).await;
    sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES($1,$2,'2026-05-01','l80',true,37,127)").bind(racing).bind(u2).execute(&db).await.unwrap();
    discover_page(&db, racing, None).await.unwrap();
    sqlx::query("CREATE FUNCTION repair113_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO stats_rebuild_queue(device_id,date) VALUES(NEW.device_id,NEW.date) ON CONFLICT(device_id,date) DO UPDATE SET generation=stats_rebuild_queue.generation+1; RETURN NEW; END $$").execute(&admin).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER repair113_generation AFTER INSERT OR UPDATE ON daily_stats FOR EACH ROW WHEN(NEW.device_id={racing}) EXECUTE FUNCTION repair113_generation()"))
        .execute(&admin).await.unwrap();
    process_queue(&db).await.unwrap();
    let generation: i64 =
        sqlx::query_scalar("SELECT generation FROM stats_rebuild_queue WHERE device_id=$1")
            .bind(racing)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(generation, 2);
    sqlx::query("DROP TRIGGER repair113_generation ON daily_stats")
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION repair113_generation()")
        .execute(&admin)
        .await
        .unwrap();
    process_queue(&db).await.unwrap();
    assert_eq!(count(&db, racing, "stats_rebuild_queue").await, 0);
    println!("PASS new-generation-survives-old-ack");

    // Collection pause prevents NEW fixes, but explicitly allows retained-history
    // correction. Use pause (tested above) prevents both reads and derivation.
    sqlx::query("UPDATE device_data_controls SET collection_paused=true WHERE device_id=$1")
        .bind(racing)
        .execute(&db)
        .await
        .unwrap();
    assert!(sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES($1,$2,'2026-05-02','l80',true,37,127)").bind(racing).bind(u2).execute(&db).await.is_err());
    sqlx::query("DELETE FROM daily_stats WHERE device_id=$1")
        .bind(racing)
        .execute(&db)
        .await
        .unwrap();
    discover_page(&db, racing, None).await.unwrap();
    process_queue(&db).await.unwrap();
    assert_eq!(count(&db, racing, "daily_stats").await, 1);
    println!("PASS collection-pause-retained-history-only");

    // Invalid fixes/empty batches contribute no invented dates or zero stats.
    let invalid = device(&db, u2).await;
    sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,fixes_jsonb) VALUES($1,$2,'2026-06-01','l80',false,NULL),($1,$2,'2026-06-02','l80',false,'[]')").bind(invalid).bind(u2).execute(&db).await.unwrap();
    discover_page(&db, invalid, None).await.unwrap();
    assert_eq!(count(&db, invalid, "stats_rebuild_queue").await, 0);
    assert_eq!(count(&db, invalid, "daily_stats").await, 0);
    println!("PASS no-fix/empty-batch/no-invented-days; runtime restriction verified; schema112 unchanged");
}
