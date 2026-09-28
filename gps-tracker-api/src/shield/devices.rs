use super::*;
use axum::extract::{
    ws::{Message, WebSocketUpgrade},
    Path, Query,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;

pub async fn own(app: &App, user: i64, id: i64) -> Result<()> {
    let owned: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2)")
            .bind(id)
            .bind(user)
            .fetch_one(&app.db)
            .await?;
    if owned {
        Ok(())
    } else {
        Err(missing())
    }
}
pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'device_uid',device_uid,'display_name',display_name,'last_seen_at',last_seen_at,'paired_at',paired_at,'sim_last4',right(sim_iccid,4),'sim_updated_at',sim_updated_at) FROM devices WHERE owner_id=$1 ORDER BY paired_at,id")
        .bind(user).fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    claim_code: String,
    display_name: String,
}
pub async fn claim(
    State(app): State<App>,
    h: HeaderMap,
    Json(input): Json<Claim>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    auth::rate(&app, format!("claim:{user}"), 20).await?;
    let name = input.display_name.trim();
    if input.claim_code.len() != 64 || name.is_empty() || name.chars().count() > 60 {
        return Err(bad("장치 이름과 등록 코드를 확인해 주세요."));
    }
    let id:Option<i64>=sqlx::query_scalar("UPDATE devices SET owner_id=$1,display_name=$2,paired_at=now(),claim_hash=NULL WHERE claim_hash=$3 AND owner_id IS NULL RETURNING id")
        .bind(user).bind(name).bind(hash(&input.claim_code)).fetch_optional(&app.db).await?;
    Ok(Json(
        json!({"id":id.ok_or_else(||bad("이미 등록되었거나 유효하지 않은 장치 코드입니다."))?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Range {
    since: DateTime<Utc>,
    until: DateTime<Utc>,
    before: Option<DateTime<Utc>>,
    before_id: Option<i64>,
    limit: Option<i64>,
}
impl Range {
    fn validate(&self) -> Result<()> {
        if self.until <= self.since
            || self.until - self.since > chrono::Duration::days(7)
            || self.until > Utc::now() + chrono::Duration::minutes(1)
        {
            return Err(bad(
                "조회 기간은 최대 7일이며 시작 시각이 종료 시각보다 빨라야 합니다.",
            ));
        }
        if self
            .before
            .is_some_and(|b| b < self.since || b > self.until)
        {
            return Err(bad("페이지 범위를 확인해 주세요."));
        }
        Ok(())
    }
}
pub async fn summary(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Query(r): Query<Range>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    own(&app, user, id).await?;
    r.validate()?;
    let value: Option<Value> = sqlx::query_scalar(include_str!("summary.sql"))
        .bind(id)
        .bind(user)
        .bind(r.since)
        .bind(r.until)
        .fetch_optional(&app.db)
        .await?;
    Ok(Json(value.ok_or_else(missing)?))
}
pub async fn readings(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Query(r): Query<Range>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    own(&app, user, id).await?;
    r.validate()?;
    let limit = r.limit.unwrap_or(50).clamp(1, 1000);
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(v) FROM (SELECT id,recorded_at,received_at,measured_at,temp_c,hum_pct,pv_mv,csq,reg,gnss,build_tag,device_uptime_s FROM readings WHERE device_id=$1 AND user_id=$2 AND recorded_at>=$3 AND recorded_at<$4 AND ($5::timestamptz IS NULL OR (recorded_at,id)<($5,$6)) AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2) ORDER BY recorded_at DESC,id DESC LIMIT $7) v")
        .bind(id).bind(user).bind(r.since).bind(r.until).bind(r.before).bind(r.before_id.unwrap_or(i64::MAX)).bind(limit+1).fetch_all(&app.db).await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next = if more {
        rows.last()
            .map(|v| json!({"before":v["recorded_at"],"before_id":v["id"]}))
    } else {
        None
    };
    Ok(Json(json!({"items":rows,"next":next})))
}
pub async fn locations(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Query(r): Query<Range>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    own(&app, user, id).await?;
    r.validate()?;
    let limit = r.limit.unwrap_or(1000).clamp(1, 1000);
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(v) FROM (SELECT recorded_at,fix,lat,lng,sat,speed_kmh,speed_reason FROM location_speed_points_between($1,$2,$3,$4) WHERE recorded_at<$4 AND ($5::timestamptz IS NULL OR recorded_at<$5) AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2) ORDER BY recorded_at DESC LIMIT $6) v")
        .bind(id).bind(user).bind(r.since).bind(r.until).bind(r.before).bind(limit+1).fetch_all(&app.db).await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next = if more {
        rows.last().map(|v| v["recorded_at"].clone())
    } else {
        None
    };
    Ok(Json(json!({"items":rows,"next":next})))
}
pub async fn ws(
    State(app): State<App>,
    h: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response> {
    if h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(&app.origin) {
        return Err(denied());
    }
    let user = auth::user(&app, &h).await?;
    Ok(upgrade.on_upgrade(move|mut socket|async move {
        let mut events=app.events.subscribe();let mut check=tokio::time::interval(Duration::from_secs(25));
        loop {tokio::select!{
            _=check.tick()=>{
                if auth::user(&app,&h).await.ok()!=Some(user){let _=socket.close().await;break;}
                if socket.send(Message::Ping(Vec::new())).await.is_err(){break;}
            },
            event=events.recv()=>{match event {
                Ok((owner,id)) if owner==user=>{
                    if auth::user(&app,&h).await.ok()!=Some(user){let _=socket.close().await;break;}
                    if own(&app,user,id).await.is_ok() && socket.send(Message::Text(json!({"kind":"device_changed","device_id":id}).to_string())).await.is_err(){break;}
                },
                Err(broadcast::error::RecvError::Lagged(_))=>{if socket.send(Message::Text("{\"kind\":\"refresh\"}".into())).await.is_err(){break;}},
                Err(broadcast::error::RecvError::Closed)=>break,_=>{}
            }},
            msg=socket.recv()=>{if matches!(msg,None|Some(Err(_))|Some(Ok(Message::Close(_)))){break;}}
        }}
    }).into_response())
}
