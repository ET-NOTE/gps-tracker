use super::*;
use axum::extract::Path;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Post {
    pub id: String,
    title: String,
    description: String,
    category: String,
    level: String,
    minutes: i32,
    variant: String,
    steps: Vec<String>,
    #[serde(default)]
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    content: Post,
    published: bool,
    revision: i32,
}
fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn validate(p: &Post) -> Result<()> {
    if !valid_slug(&p.id)
        || p.title.trim().is_empty()
        || p.title.chars().count() > 120
        || p.description.chars().count() > 500
        || p.category.chars().count() > 40
        || !["입문", "기초", "응용"].contains(&p.level.as_str())
        || !(1..=600).contains(&p.minutes)
        || !["board", "sensor", "data"].contains(&p.variant.as_str())
        || p.steps.is_empty()
        || p.steps.len() > 50
        || p.steps
            .iter()
            .any(|s| s.trim().is_empty() || s.chars().count() > 2000)
        || p.code.len() > 16000
    {
        return Err(bad(
            "제목·설명·단계·예제 코드의 길이와 형식을 확인해 주세요.",
        ));
    }
    Ok(())
}
pub async fn list(State(app): State<App>) -> Result<Json<Value>> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT content || jsonb_build_object('revision',revision,'updated_at',updated_at) FROM content_posts WHERE published ORDER BY created_at,slug").fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
pub async fn admin_list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin::require(&app, &h).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('content',content,'published',published,'revision',revision,'updated_at',updated_at) FROM content_posts ORDER BY updated_at DESC LIMIT 500").fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
pub async fn save(
    State(app): State<App>,
    h: HeaderMap,
    Path(slug): Path<String>,
    Json(v): Json<Edit>,
) -> Result<Json<Value>> {
    let actor = admin::require(&app, &h).await?;
    validate(&v.content)?;
    if slug != v.content.id {
        return Err(bad("게시물 주소를 확인해 주세요."));
    }
    let mut tx = app.db.begin().await?;
    let before:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('content',content,'published',published,'revision',revision) FROM content_posts WHERE slug=$1 FOR UPDATE").bind(&slug).fetch_optional(&mut *tx).await?;
    if before
        .as_ref()
        .and_then(|b| b["revision"].as_i64())
        .unwrap_or(0)
        != i64::from(v.revision)
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "다른 관리자가 수정했습니다. 다시 불러온 뒤 저장해 주세요.".into(),
        ));
    }
    let content = serde_json::to_value(v.content).unwrap();
    let revision:Option<i32>=sqlx::query_scalar("INSERT INTO content_posts(slug,content,published,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(slug) DO UPDATE SET content=EXCLUDED.content,published=EXCLUDED.published,updated_by=EXCLUDED.updated_by,updated_at=now(),revision=content_posts.revision+1 WHERE content_posts.revision=$5 RETURNING revision")
        .bind(&slug).bind(&content).bind(v.published).bind(actor).bind(v.revision).fetch_optional(&mut *tx).await?;
    let revision = revision.ok_or_else(|| {
        Error(
            StatusCode::CONFLICT,
            "게시물이 변경되었습니다. 다시 불러와 주세요.".into(),
        )
    })?;
    admin::audit(&mut tx,Some(actor),"post.save","post",&slug,json!({"before":before,"after":{"content":content,"published":v.published,"revision":revision}})).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true,"revision":revision})))
}
pub async fn seed(db: &PgPool) -> anyhow::Result<()> {
    let posts: Vec<Value> = serde_json::from_str(include_str!("content-seed.json"))?;
    for p in posts {
        sqlx::query("INSERT INTO content_posts(slug,content,published) VALUES($1,$2,true) ON CONFLICT(slug) DO NOTHING")
        .bind(p["id"].as_str().unwrap()).bind(&p).execute(db).await?;
    }
    Ok(())
}
