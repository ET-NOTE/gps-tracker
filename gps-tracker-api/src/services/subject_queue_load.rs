//! Disposable DB + loopback HTTP only. No Firebase credentials or external network.
use super::fcm::{Delivery, FcmClient};
use super::subject_queue::*;
use serde_json::json;
use sqlx::PgPool;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[tokio::test]
#[ignore = "requires disposable internal Docker DB and loopback mock"]
async fn notice_queue_capacity_and_failure_recovery() {
    let url = std::env::var("LEDGER_TEST_DATABASE_URL").unwrap();
    assert!(url.contains("closure-test-only@") && url.ends_with("/gps_closure_test"));
    let pool = PgPool::connect(&url).await.unwrap();
    // A second pool models another API process, sharing only durable DB state.
    let other = PgPool::connect(&url).await.unwrap();
    // A newly migrated database has infinite sentinels, never subtract them.
    sqlx::query("UPDATE location_notice_worker SET seen_at=NULL,next_dispatch_at='-infinity',cooldown_until='-infinity'")
        .execute(&pool).await.unwrap();
    let empty_health = health(&pool, false).await.unwrap();
    assert_eq!(empty_health["cooldown_seconds"], 0);
    assert_eq!(empty_health["worker_age_seconds"], 2147483647_i64);
    let uid:i64=sqlx::query_scalar("INSERT INTO users(email,password_hash,phone) VALUES($1,'test',gen_random_uuid()::text) RETURNING id")
        .bind(format!("{}@example.invalid",uuid::Uuid::new_v4())).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO fcm_tokens(user_id,token,platform,active) VALUES($1,'queue-synthetic-token','android',true)").bind(uid).execute(&pool).await.unwrap();
    sqlx::query("UPDATE location_subject_policy SET enabled=true,reference='synthetic-load-policy',push_enabled=true").execute(&pool).await.unwrap();
    sqlx::query("UPDATE location_notice_worker SET next_dispatch_at=now(),cooldown_until=now()")
        .execute(&pool)
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(AtomicUsize::new(200));
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let starts = Arc::new(Mutex::new(Vec::<Instant>::new()));
    let (c, m, a, p, t) = (
        calls.clone(),
        mode.clone(),
        active.clone(),
        peak.clone(),
        starts.clone(),
    );
    let app = axum::Router::new().route(
        "/send",
        axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
            let (c, m, a, p, t) = (c.clone(), m.clone(), a.clone(), p.clone(), t.clone());
            async move {
                assert_eq!(body["message"]["token"], "queue-synthetic-token");
                assert_eq!(body["message"]["data"].as_object().unwrap().len(), 2);
                assert!(!body.to_string().contains("latitude"));
                c.fetch_add(1, Ordering::SeqCst);
                t.lock().await.push(Instant::now());
                let concurrent = a.fetch_add(1, Ordering::SeqCst) + 1;
                p.fetch_max(concurrent, Ordering::SeqCst);
                let status = m.load(Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(if status == 999 {
                    1200
                } else {
                    200
                }))
                .await;
                a.fetch_sub(1, Ordering::SeqCst);
                (
                    axum::http::StatusCode::from_u16(if status == 999 {
                        200
                    } else {
                        status as u16
                    })
                    .unwrap(),
                    [("retry-after", "120")],
                    axum::Json(json!({"name":"synthetic","error":{}})),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = Arc::new(FcmClient::subject_test_client(format!(
        "http://{addr}/send"
    )));
    const COUNT: i64 = 1200;
    sqlx::query("INSERT INTO location_provision_notices(event_id,mapping_id,subject_id,owner_id,actor_id,device_id,vehicle_id,purpose,consent_version,policy_reference,range_from,range_until,started_at,outcome,delivery) SELECT -($1*10000+g),-1,$1,$1,$1,-1,-1,'fleet_operations','fleet-subject-v1','synthetic-load-policy',now()-interval '1 day',now(),now(),'response_ready','pending' FROM generate_series(1,$2::bigint) g")
        .bind(uid).bind(COUNT).execute(&pool).await.unwrap();
    maintenance(&pool, true).await.unwrap();
    let begin = Instant::now();
    let mut jobs = tokio::task::JoinSet::new();
    for i in 0..8 {
        let db = if i < 4 { pool.clone() } else { other.clone() };
        let client = client.clone();
        jobs.spawn(async move { loop {
            let state=work(&db,Some(&client)).await.unwrap();
            let left:i64=sqlx::query_scalar("SELECT count(*) FROM location_provision_notices WHERE subject_id=$1 AND delivery='pending'").bind(uid).fetch_one(&db).await.unwrap();
            if left==0 {break;}
            tokio::time::sleep(Duration::from_millis(state.delay_ms())).await;
        }});
    }
    tokio::time::timeout(Duration::from_secs(240), async {
        while let Some(r) = jobs.join_next().await {
            r.unwrap();
        }
    })
    .await
    .unwrap();
    let seconds = begin.elapsed().as_secs_f64();
    assert_eq!(calls.load(Ordering::SeqCst), COUNT as usize);
    let count:(i64,i64)=sqlx::query_as("SELECT count(*),count(DISTINCT notice_id) FROM location_notice_attempts WHERE notice_id IN(SELECT id FROM location_provision_notices WHERE subject_id=$1) AND result='accepted'").bind(uid).fetch_one(&pool).await.unwrap();
    assert_eq!(count, (COUNT, COUNT));
    let starts = starts.lock().await;
    let mut window_peak = 0;
    for (i, start) in starts.iter().enumerate() {
        window_peak = window_peak.max(
            starts[i..]
                .iter()
                .take_while(|s| s.duration_since(*start) < Duration::from_secs(1))
                .count(),
        );
    }
    // HTTP scheduling has jitter relative to DB reservations; allow one boundary crossing.
    assert!(window_peak <= 11, "global rate burst: {window_peak}");
    assert!((119.0..240.0).contains(&seconds));
    drop(starts);
    let notice: i64 =
        sqlx::query_scalar("SELECT min(id) FROM location_provision_notices WHERE subject_id=$1")
            .bind(uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    async fn reset(pool: &PgPool, id: i64) {
        sqlx::query("UPDATE location_provision_notices SET delivery='pending',attempts=0,lease_id=NULL,lease_until=NULL,available_at=now() WHERE id=$1").bind(id).execute(pool).await.unwrap();
        sqlx::query(
            "UPDATE location_notice_worker SET next_dispatch_at=now(),cooldown_until=now()",
        )
        .execute(pool)
        .await
        .unwrap();
    }
    for code in [429, 503] {
        reset(&pool, notice).await;
        mode.store(code, Ordering::SeqCst);
        tick(&pool, Some(&client)).await.unwrap();
        let before = calls.load(Ordering::SeqCst);
        for _ in 0..4 {
            assert!(!tick(&other, Some(&client)).await.unwrap());
        }
        assert_eq!(calls.load(Ordering::SeqCst), before);
        let h = health(&pool, true).await.unwrap();
        assert!(h["cooldown_seconds"].as_i64().unwrap() >= 118);
        assert!(h["alerts"]
            .as_array()
            .unwrap()
            .contains(&json!("provider_cooldown")));
        let lease = uuid::Uuid::new_v4();
        settle(
            &pool,
            notice,
            lease,
            1,
            Delivery::Retry(86400, "http_429".into()),
        )
        .await
        .unwrap();
        assert!(
            health(&pool, true).await.unwrap()["cooldown_seconds"]
                .as_i64()
                .unwrap()
                < 130
        );
    }
    // Cancellation models process death after HTTP send, before settlement. The
    // replacement respects the live lease; replay after expiry is at-least-once.
    reset(&pool, notice).await;
    mode.store(999, Ordering::SeqCst);
    let before = calls.load(Ordering::SeqCst);
    let (db, c) = (pool.clone(), client.clone());
    let task = tokio::spawn(async move { tick(&db, Some(&c)).await });
    while calls.load(Ordering::SeqCst) == before {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    task.abort();
    let _ = task.await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!tick(&other, Some(&client)).await.unwrap());
    sqlx::query("UPDATE location_provision_notices SET lease_until=now()-interval '1 second',available_at=now() WHERE id=$1").bind(notice).execute(&pool).await.unwrap();
    assert!(health(&pool, true).await.unwrap()["alerts"]
        .as_array()
        .unwrap()
        .contains(&json!("lease_expired")));
    tokio::time::sleep(Duration::from_millis(110)).await;
    mode.store(200, Ordering::SeqCst);
    tick(&other, Some(&client)).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), before + 2);
    // Disabled policy, missing client and revoked recipient never emit a request.
    reset(&pool, notice).await;
    let before = calls.load(Ordering::SeqCst);
    tick(&pool, None).await.unwrap();
    sqlx::query("UPDATE location_subject_policy SET push_enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    tick(&pool, Some(&client)).await.unwrap();
    assert!(health(&pool, true).await.unwrap()["alerts"]
        .as_array()
        .unwrap()
        .contains(&json!("delivery_paused")));
    sqlx::query("UPDATE location_subject_policy SET push_enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE fcm_tokens SET active=false WHERE user_id=$1")
        .bind(uid)
        .execute(&pool)
        .await
        .unwrap();
    tick(&pool, Some(&client)).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), before);
    sqlx::query("UPDATE location_provision_notices SET started_at=now()-interval '16 minutes',attempts=10,lease_until=now()-interval '1 second' WHERE id=$1").bind(notice).execute(&pool).await.unwrap();
    sqlx::query("UPDATE location_notice_worker SET seen_at=now()-interval '61 seconds'")
        .execute(&pool)
        .await
        .unwrap();
    let h = health(&pool, true).await.unwrap();
    assert_eq!(h["severity"], "critical");
    assert!(h["alerts"]
        .as_array()
        .unwrap()
        .contains(&json!("worker_stale")));
    assert!(h["alerts"]
        .as_array()
        .unwrap()
        .contains(&json!("backlog_critical")));
    maintenance(&pool, true).await.unwrap();
    let h = health(&pool, false).await.unwrap();
    assert!(h["alerts"]
        .as_array()
        .unwrap()
        .contains(&json!("manual_review")));
    // Provider deadline uses the same production timeout path (no reduced test constant).
    reset(&pool, notice).await;
    sqlx::query("UPDATE fcm_tokens SET active=true WHERE user_id=$1")
        .bind(uid)
        .execute(&pool)
        .await
        .unwrap();
    let blackhole = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let hang_client =
        FcmClient::subject_test_client(format!("http://{}/send", blackhole.local_addr().unwrap()));
    let hang = tokio::spawn(async move {
        let (_socket, _) = blackhole.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
    });
    let at = Instant::now();
    tick(&pool, Some(&hang_client)).await.unwrap();
    assert!(at.elapsed().as_secs() >= 50 && at.elapsed().as_secs() < 55);
    hang.abort();
    let reason: String =
        sqlx::query_scalar("SELECT last_error FROM location_provision_notices WHERE id=$1")
            .bind(notice)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(reason, "dispatch_timeout_unknown");
    let report = json!({"synthetic_only":true,"notice_count":COUNT,"parallel_worker_loops":8,"database_pools":2,"mock_latency_ms":200,"seconds":seconds,"accepted_per_second":COUNT as f64/seconds,"max_http_starts_in_one_second":window_peak,"peak_http_inflight":peak.load(Ordering::SeqCst),"unique_settlements":COUNT,"cooldown_429_503_shared":true,"crash_replay_at_least_once":true,"stale_settlement_cannot_change_cooldown":true,"policy_off_and_revoked_token_blocked":true,"worker_backlog_review_alarms":true,"full_50s_deadline":true,"no_external_send":true});
    println!("QUEUE_LOAD_REPORT={report}");
    if let Ok(path) = std::env::var("GPS_QUEUE_LOAD_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    sqlx::query("DELETE FROM location_notice_attempts WHERE notice_id IN(SELECT id FROM location_provision_notices WHERE subject_id=$1)").bind(uid).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM location_provision_notices WHERE subject_id=$1")
        .bind(uid)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM fcm_tokens WHERE user_id=$1")
        .bind(uid)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE location_subject_policy SET enabled=false,push_enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE location_notice_worker SET cooldown_until=now()")
        .execute(&pool)
        .await
        .unwrap();
    server.abort();
}
