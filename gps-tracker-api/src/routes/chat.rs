// /api/v1/chat/* — 사용자 ↔ 관리자 1:1 채팅 (모든 admin 공동 inbox).
//
// 사용자: 자기 thread 의 메시지 조회/송신.
// 관리자: 모든 thread 목록, 각 thread 메시지 조회/송신, 읽음 처리.
//
// MVP: 5초 폴링, WS push 는 나중. unread_for_user / unread_for_admin 카운터로 뱃지.

use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

use crate::{
    auth::{AdminUser, AuthUser},
    error::{AppError, AppResult},
    events::{ChatMessagePayload, Event},
    state::AppState,
};

pub fn router_user() -> Router<AppState> {
    Router::new()
        .route("/chat/thread",          get(my_thread))
        .route("/chat/messages",        get(my_messages).post(send_user_message))
        .route("/chat/read",            post(mark_read_user))
}

pub fn router_admin() -> Router<AppState> {
    Router::new()
        .route("/admin/chat/threads",                       get(list_threads))
        .route("/admin/chat/threads/:thread_id/messages",   get(thread_messages).post(send_admin_message))
        .route("/admin/chat/threads/:thread_id/read",       post(mark_read_admin))
        .route("/admin/chat/search",                        get(search_messages))
}

// (F7-b) WS push helper — 대상 user_id 에게 ChatMessage 이벤트 broadcast.
// broadcast::Sender.send 는 subscriber 없어도 무해 (Err 반환, 무시).
fn push_chat_message(state: &AppState, target_user_id: i64, row: &MessageRow) {
    let payload = ChatMessagePayload {
        id: row.id,
        thread_id: row.thread_id,
        sender_role: row.sender_role.clone(),
        sender_id: row.sender_id,
        body: row.body.clone(),
        created_at: row.created_at,
    };
    let _ = state.events.send(Event::ChatMessage {
        target_user_id,
        message: payload,
    });
}

// (F7-b) 사용자→관리자 메시지: 모든 admin 사용자 id 를 조회해 각각 push.
// admin 수는 소수 (수십~수백) 이라 매 메시지 조회 부담 낮음.
async fn push_to_admins_ws(state: &AppState, row: &MessageRow) {
    let admin_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM users WHERE role = 'admin'",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for uid in admin_ids {
        push_chat_message(state, uid, row);
    }
}

// ─── 공통 row 타입 ─────────────────────────────────────
#[derive(Debug, Serialize, FromRow)]
struct MessageRow {
    id:          i64,
    thread_id:   i64,
    sender_role: String,
    sender_id:   Option<i64>,
    body:        String,
    meta:        Option<Value>,
    created_at:  DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
struct ThreadRow {
    id:                i64,
    user_id:           i64,
    user_email:        Option<String>,
    user_display:      Option<String>,
    last_message_at:   Option<DateTime<Utc>>,
    last_message_text: Option<String>,
    unread_for_user:   i32,
    unread_for_admin:  i32,
    created_at:        DateTime<Utc>,
}

// ─── 사용자: 내 thread (필요 시 lazy 생성) ──────────────
async fn ensure_thread(state: &AppState, user_id: i64) -> AppResult<i64> {
    let id: i64 = sqlx::query_scalar(
        r#"INSERT INTO chat_threads (user_id) VALUES ($1)
           ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
           RETURNING id"#,
    )
    .bind(user_id).fetch_one(&state.db).await?;
    Ok(id)
}

#[derive(Debug, Serialize)]
struct MyThreadView {
    thread_id:        i64,
    unread_for_user:  i32,
    last_message_at:  Option<DateTime<Utc>>,
}

async fn my_thread(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<MyThreadView>> {
    let thread_id = ensure_thread(&state, user.user_id).await?;
    let row: Option<(i32, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT unread_for_user, last_message_at FROM chat_threads WHERE id = $1",
    )
    .bind(thread_id).fetch_optional(&state.db).await?;
    let (unread, last) = row.unwrap_or((0, None));
    Ok(Json(MyThreadView {
        thread_id,
        unread_for_user: unread,
        last_message_at: last,
    }))
}

#[derive(Debug, Deserialize)]
struct MessagesQuery {
    after_id: Option<i64>,    // 폴링: 이 id 이후만
    limit:    Option<i64>,
}

async fn my_messages(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<MessagesQuery>,
) -> AppResult<Json<Vec<MessageRow>>> {
    let thread_id = ensure_thread(&state, user.user_id).await?;
    let limit = q.limit.unwrap_or(100).min(500);
    let rows = if let Some(after) = q.after_id {
        sqlx::query_as::<_, MessageRow>(
            r#"SELECT id, thread_id, sender_role, sender_id, body, meta, created_at
                 FROM chat_messages
                WHERE thread_id = $1 AND id > $2
                ORDER BY id ASC LIMIT $3"#,
        )
        .bind(thread_id).bind(after).bind(limit)
        .fetch_all(&state.db).await?
    } else {
        // 최근 N → 시간순 재정렬
        let rows = sqlx::query_as::<_, MessageRow>(
            r#"SELECT id, thread_id, sender_role, sender_id, body, meta, created_at
                 FROM chat_messages
                WHERE thread_id = $1
                ORDER BY id DESC LIMIT $2"#,
        )
        .bind(thread_id).bind(limit)
        .fetch_all(&state.db).await?;
        let mut v = rows; v.reverse(); v
    };
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct SendReq {
    body: String,
}

async fn send_user_message(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<SendReq>,
) -> AppResult<Json<MessageRow>> {
    let body = req.body.trim().to_string();
    if body.is_empty() || body.len() > 4000 {
        return Err(AppError::BadRequest("message body 1..=4000".into()));
    }
    let thread_id = ensure_thread(&state, user.user_id).await?;

    let row: MessageRow = sqlx::query_as(
        r#"INSERT INTO chat_messages (thread_id, sender_role, sender_id, body)
           VALUES ($1, 'user', $2, $3)
           RETURNING id, thread_id, sender_role, sender_id, body, meta, created_at"#,
    )
    .bind(thread_id).bind(user.user_id).bind(&body)
    .fetch_one(&state.db).await?;

    sqlx::query(
        r#"UPDATE chat_threads
              SET last_message_at   = NOW(),
                  last_message_text = $2,
                  unread_for_admin  = unread_for_admin + 1
            WHERE id = $1"#,
    )
    .bind(thread_id).bind(&body)
    .execute(&state.db).await?;

    // 모든 admin 에게 푸시 (best-effort, 실패해도 메시지는 정상 저장됨)
    let sender_email = sender_label(&state, user.user_id).await;
    let title = format!("새 메시지 — {}", sender_email);
    let pool = state.db.clone();
    let fcm = state.fcm.clone();
    let body_clone = body.clone();
    let user_id = user.user_id;
    let thread_id_clone = thread_id;
    tokio::spawn(async move {
        crate::services::fcm::push_to_admins(
            fcm.as_deref(), &pool,
            Some(user_id),                   // 발신자(=같은 admin 일 수도 있음) 는 제외
            &title, &body_clone,
            serde_json::json!({
                "kind":      "chat_user_message",
                "thread_id": thread_id_clone.to_string(),
                "user_id":   user_id.to_string(),
            }),
        ).await;
    });

    // (F7-b) WS realtime push — 모든 admin 에게 broadcast (open WS 만 실제 전송).
    push_to_admins_ws(&state, &row).await;

    Ok(Json(row))
}

async fn sender_label(state: &AppState, user_id: i64) -> String {
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT display_name, email FROM users WHERE id = $1",
    )
    .bind(user_id).fetch_optional(&state.db).await.ok().flatten();
    match row {
        Some((Some(n), _)) if !n.is_empty() => n,
        Some((_, e)) => e,
        None => format!("uid:{user_id}"),
    }
}

async fn mark_read_user(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Value>> {
    let thread_id = ensure_thread(&state, user.user_id).await?;
    sqlx::query("UPDATE chat_threads SET unread_for_user = 0 WHERE id = $1")
        .bind(thread_id).execute(&state.db).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─── 관리자: 모든 스레드 ────────────────────────────────
async fn list_threads(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<ThreadRow>>> {
    // admin 역할 사용자의 thread 는 제외 — 운영자가 자기 채팅 카드 열면서 만들어진
    // 빈 thread / 자기 자신과의 대화가 inbox 에 끼는 걸 막음.
    let rows = sqlx::query_as::<_, ThreadRow>(
        r#"SELECT t.id, t.user_id,
                  u.email AS user_email, u.display_name AS user_display,
                  t.last_message_at, t.last_message_text,
                  t.unread_for_user, t.unread_for_admin,
                  t.created_at
             FROM chat_threads t
        LEFT JOIN users u ON u.id = t.user_id
            WHERE COALESCE(u.role, 'user') <> 'admin'
            ORDER BY (t.unread_for_admin > 0) DESC,
                     COALESCE(t.last_message_at, t.created_at) DESC
            LIMIT 200"#,
    )
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

async fn thread_messages(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<MessagesQuery>,
) -> AppResult<Json<Vec<MessageRow>>> {
    let limit = q.limit.unwrap_or(100).min(500);
    let rows = if let Some(after) = q.after_id {
        sqlx::query_as::<_, MessageRow>(
            r#"SELECT id, thread_id, sender_role, sender_id, body, meta, created_at
                 FROM chat_messages
                WHERE thread_id = $1 AND id > $2
                ORDER BY id ASC LIMIT $3"#,
        )
        .bind(thread_id).bind(after).bind(limit)
        .fetch_all(&state.db).await?
    } else {
        let rows = sqlx::query_as::<_, MessageRow>(
            r#"SELECT id, thread_id, sender_role, sender_id, body, meta, created_at
                 FROM chat_messages
                WHERE thread_id = $1
                ORDER BY id DESC LIMIT $2"#,
        )
        .bind(thread_id).bind(limit)
        .fetch_all(&state.db).await?;
        let mut v = rows; v.reverse(); v
    };
    Ok(Json(rows))
}

async fn send_admin_message(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Json(req): Json<SendReq>,
) -> AppResult<Json<MessageRow>> {
    let body = req.body.trim().to_string();
    if body.is_empty() || body.len() > 4000 {
        return Err(AppError::BadRequest("message body 1..=4000".into()));
    }
    // thread 존재 확인 + 대상 user_id 확보
    let target_user: Option<i64> = sqlx::query_scalar(
        "SELECT user_id FROM chat_threads WHERE id = $1",
    )
    .bind(thread_id).fetch_optional(&state.db).await?;
    let target_user_id = target_user.ok_or(AppError::NotFound)?;

    let row: MessageRow = sqlx::query_as(
        r#"INSERT INTO chat_messages (thread_id, sender_role, sender_id, body)
           VALUES ($1, 'admin', $2, $3)
           RETURNING id, thread_id, sender_role, sender_id, body, meta, created_at"#,
    )
    .bind(thread_id).bind(admin.user_id).bind(&body)
    .fetch_one(&state.db).await?;

    sqlx::query(
        r#"UPDATE chat_threads
              SET last_message_at   = NOW(),
                  last_message_text = $2,
                  unread_for_user   = unread_for_user + 1
            WHERE id = $1"#,
    )
    .bind(thread_id).bind(&body)
    .execute(&state.db).await?;

    // 사용자에게 푸시 (best-effort)
    let pool = state.db.clone();
    let fcm = state.fcm.clone();
    let body_clone = body.clone();
    tokio::spawn(async move {
        crate::services::fcm::push_to_user(
            fcm.as_deref(), &pool, target_user_id,
            "관리자 메시지", &body_clone,
            serde_json::json!({
                "kind":      "chat_admin_message",
                "thread_id": thread_id.to_string(),
            }),
        ).await;
    });

    // (F7-b) WS realtime push — 대상 사용자에게 전송.
    push_chat_message(&state, target_user_id, &row);

    Ok(Json(row))
}

async fn mark_read_admin(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
) -> AppResult<Json<Value>> {
    sqlx::query("UPDATE chat_threads SET unread_for_admin = 0 WHERE id = $1")
        .bind(thread_id).execute(&state.db).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─── 관리자: 메시지 통합 검색 (사용자/내용/날짜) ─────────
#[derive(Debug, Deserialize)]
struct SearchQuery {
    user_id: Option<i64>,                    // 특정 사용자만
    user:    Option<String>,                 // 이메일/이름 부분일치
    q:       Option<String>,                 // 메시지 본문 부분일치
    from:    Option<DateTime<Utc>>,          // ISO8601
    to:      Option<DateTime<Utc>>,
    limit:   Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
struct SearchHit {
    id:           i64,
    thread_id:    i64,
    user_id:      i64,
    user_email:   Option<String>,
    user_display: Option<String>,
    sender_role:  String,
    body:         String,
    created_at:   DateTime<Utc>,
}

async fn search_messages(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<Vec<SearchHit>>> {
    let limit  = q.limit.unwrap_or(200).clamp(1, 1000);
    let uid    = q.user_id.unwrap_or(-1);
    let user_pat = format!("%{}%", q.user.unwrap_or_default().trim().to_lowercase());
    let q_pat    = format!("%{}%", q.q.unwrap_or_default().trim().to_lowercase());

    let rows = sqlx::query_as::<_, SearchHit>(
        r#"
        SELECT m.id, m.thread_id, t.user_id,
               u.email AS user_email, u.display_name AS user_display,
               m.sender_role, m.body, m.created_at
          FROM chat_messages m
          JOIN chat_threads t ON t.id = m.thread_id
     LEFT JOIN users u        ON u.id = t.user_id
         WHERE ($1 = -1 OR t.user_id = $1)
           AND ($2 = '%%' OR LOWER(COALESCE(u.email,'')) LIKE $2
                          OR LOWER(COALESCE(u.display_name,'')) LIKE $2)
           AND ($3 = '%%' OR LOWER(m.body) LIKE $3)
           AND ($4::timestamptz IS NULL OR m.created_at >= $4)
           AND ($5::timestamptz IS NULL OR m.created_at <= $5)
           AND COALESCE(u.role, 'user') <> 'admin'
         ORDER BY m.created_at DESC
         LIMIT $6
        "#,
    )
    .bind(uid)
    .bind(&user_pat)
    .bind(&q_pat)
    .bind(q.from)
    .bind(q.to)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}
