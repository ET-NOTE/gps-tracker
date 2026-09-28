use super::*;
use axum::http::HeaderValue;
use serde::Deserialize;

pub fn cookie_name(app: &App) -> &'static str {
    if app.secure {
        "__Host-shield_session"
    } else {
        "shield_preview_session"
    }
}
fn session_token(app: &App, h: &HeaderMap) -> Option<String> {
    h.get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (name == cookie_name(app) && value.len() == 64).then(|| value.to_owned())
        })
}
pub async fn user(app: &App, h: &HeaderMap) -> Result<i64> {
    let token = session_token(app, h).ok_or_else(denied)?;
    sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()")
        .bind(hash(&token))
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(denied)
}
pub async fn rate(app: &App, bucket: String, max: i32) -> Result<()> {
    let count:i32=sqlx::query_scalar("INSERT INTO auth_attempts(bucket,started_at,attempts) VALUES($1,now(),1) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN auth_attempts.started_at<now()-interval '15 minutes' THEN 1 ELSE auth_attempts.attempts+1 END,started_at=CASE WHEN auth_attempts.started_at<now()-interval '15 minutes' THEN now() ELSE auth_attempts.started_at END RETURNING attempts")
        .bind(bucket).fetch_one(&app.db).await?;
    if count > max {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "시도가 많습니다. 15분 후 다시 시도해 주세요.".into(),
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    email: String,
    password: String,
    display_name: Option<String>,
    invite_code: Option<String>,
}
fn validate(c: &Credentials) -> Result<String> {
    let email = c.email.trim().to_lowercase();
    use validator::ValidateEmail;
    let password_length = c.password.chars().count();
    if email.len() > 254 || !email.validate_email() || !(10..=128).contains(&password_length) {
        return Err(bad("이메일과 10~128자 비밀번호를 확인해 주세요."));
    }
    Ok(email)
}
async fn issue(app: &App, id: i64, old_headers: &HeaderMap) -> Result<Response> {
    let token = secret();
    let mut tx = app.db.begin().await?;
    if let Some(old) = session_token(app, old_headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(hash(&old))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM sessions WHERE expires_at<now() OR (user_id=$1 AND token_hash IN (SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY expires_at DESC OFFSET 9))").bind(id).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    )
    .bind(hash(&token))
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800{}",
        cookie_name(app),
        token,
        if app.secure { "; Secure" } else { "" }
    );
    Ok((
        [(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap())],
        Json(json!({"ok":true})),
    )
        .into_response())
}
pub async fn register(
    State(app): State<App>,
    h: HeaderMap,
    Json(c): Json<Credentials>,
) -> Result<Response> {
    let email = validate(&c)?;
    rate(&app, "registration".into(), 30).await?;
    let name = c.display_name.as_deref().unwrap_or("").trim();
    if name.is_empty() || name.chars().count() > 50 {
        return Err(bad("표시 이름은 1~50자로 입력해 주세요."));
    }
    let invite = c.invite_code.as_deref().unwrap_or("");
    if invite.len() != 64 {
        return Err(bad("유효한 초대코드를 입력해 주세요."));
    }
    let permit = app
        .password_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            Error(
                StatusCode::TOO_MANY_REQUESTS,
                "잠시 후 다시 시도해 주세요.".into(),
            )
        })?;
    let password = c.password;
    let encoded = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::password::hash(&password).map_err(|_| ())
    })
    .await
    .map_err(|_| bad("가입 처리 실패"))?
    .map_err(|_| bad("가입 처리 실패"))?;
    let mut tx = app.db.begin().await?;
    let usable:Option<String>=sqlx::query_scalar("SELECT code_hash FROM invites WHERE code_hash=$1 AND consumed_by IS NULL AND expires_at>now() FOR UPDATE")
        .bind(hash(invite)).fetch_optional(&mut *tx).await?;
    let code = usable.ok_or_else(|| bad("초대코드가 만료되었거나 이미 사용되었습니다."))?;
    let id:Option<i64>=sqlx::query_scalar("INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING id")
        .bind(email).bind(encoded).bind(name).fetch_optional(&mut *tx).await?;
    let id = id.ok_or_else(|| bad("가입할 수 없는 이메일입니다. 로그인 정보를 확인해 주세요."))?;
    sqlx::query("UPDATE invites SET consumed_by=$1,consumed_at=now() WHERE code_hash=$2")
        .bind(id)
        .bind(code)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    issue(&app, id, &h).await
}
pub async fn login(
    State(app): State<App>,
    h: HeaderMap,
    Json(c): Json<Credentials>,
) -> Result<Response> {
    let email = validate(&c)?;
    rate(&app, "login-global".into(), 100).await?;
    rate(&app, format!("login:{}", hash(&email)), 10).await?;
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id,password_hash FROM users WHERE email=$1")
            .bind(email)
            .fetch_optional(&app.db)
            .await?;
    let permit = app
        .password_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            Error(
                StatusCode::TOO_MANY_REQUESTS,
                "잠시 후 다시 시도해 주세요.".into(),
            )
        })?;
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        match row {
            Some((id, encoded)) if crate::password::verify(&c.password, &encoded) => Some(id),
            _ => None,
        }
    })
    .await
    .map_err(|_| denied())?;
    issue(
        &app,
        result.ok_or_else(|| {
            Error(
                StatusCode::UNAUTHORIZED,
                "이메일 또는 비밀번호를 확인해 주세요.".into(),
            )
        })?,
        &h,
    )
    .await
}
pub async fn session(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let id = user(&app, &h).await?;
    let value:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'email',email,'display_name',display_name) FROM users WHERE id=$1").bind(id).fetch_one(&app.db).await?;
    Ok(Json(value))
}
pub async fn logout(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    if let Some(token) = session_token(&app, &h) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(hash(&token))
            .execute(&app.db)
            .await?;
    }
    let cookie = format!(
        "{}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
        cookie_name(&app),
        if app.secure { "; Secure" } else { "" }
    );
    Ok((
        [(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap())],
        Json(json!({"ok":true})),
    )
        .into_response())
}
