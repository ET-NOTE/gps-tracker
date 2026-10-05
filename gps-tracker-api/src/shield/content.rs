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
    step_titles: Vec<String>,
    #[serde(default = "example_kind")]
    kind: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
    #[serde(default)]
    images: Vec<PostImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thumbnail: Option<images::Thumbnail>,
    #[serde(default)]
    code: String,
}
fn example_kind() -> String {
    "example".into()
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Attachment {
    id: String,
    title: String,
    after_step: usize,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PostImage {
    id: String,
    after_step: usize,
    alt: String,
    caption: String,
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
        || !["example", "project"].contains(&p.kind.as_str())
        || (!p.step_titles.is_empty() && p.step_titles.len() != p.steps.len())
        || p.step_titles
            .iter()
            .any(|s| s.trim().is_empty() || s.chars().count() > 80)
        || p.attachments.len() > 10
        || p.attachments.iter().any(|a| {
            !images::valid_id(&a.id)
                || a.title.trim().is_empty()
                || a.title.chars().count() > 120
                || a.after_step > p.steps.len()
        })
        || (p.kind == "project" && (!p.code.is_empty() || !p.attachments.is_empty()))
        || p.images.len() > 20
        || p.thumbnail
            .as_ref()
            .is_some_and(|t| !images::valid_thumbnail(t))
        || p.images.iter().any(|i| {
            !images::valid_id(&i.id)
                || i.after_step > p.steps.len()
                || i.alt.trim().is_empty()
                || i.alt.chars().count() > 200
                || i.caption.chars().count() > 500
        })
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
    // Guide configuration and post publication must change atomically.
    let guide: Option<String> =
        sqlx::query_scalar("SELECT guide_slug FROM site_settings WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    if guide.as_deref().unwrap_or("start") == slug && (!v.published || v.content.kind != "example")
    {
        return Err(bad("시작가이드로 사용 중입니다. 다른 공개 기본 예제를 시작가이드로 지정한 뒤 변경해 주세요."));
    }
    let file_ids: Vec<String> = v.content.attachments.iter().map(|a| a.id.clone()).collect();
    let file_found: Vec<String> =
        sqlx::query_scalar("SELECT id FROM post_files WHERE id=ANY($1) ORDER BY id FOR KEY SHARE")
            .bind(&file_ids)
            .fetch_all(&mut *tx)
            .await?;
    if file_ids.iter().any(|id| !file_found.contains(id)) {
        return Err(bad(
            "첨부파일이 만료되었거나 없습니다. 파일을 다시 추가해 주세요.",
        ));
    }
    let mut image_ids: Vec<String> = v.content.images.iter().map(|i| i.id.clone()).collect();
    if let Some(t) = &v.content.thumbnail {
        image_ids.push(t.id.clone());
    }
    let found: Vec<String> =
        sqlx::query_scalar("SELECT id FROM post_images WHERE id=ANY($1) ORDER BY id FOR KEY SHARE")
            .bind(&image_ids)
            .fetch_all(&mut *tx)
            .await?;
    if image_ids.iter().any(|id| !found.contains(id)) {
        return Err(bad(
            "사진이 만료되었거나 존재하지 않습니다. 해당 사진을 다시 추가해 주세요.",
        ));
    }
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
    sqlx::query("DELETE FROM post_image_links WHERE post_slug=$1")
        .bind(&slug)
        .execute(&mut *tx)
        .await?;
    for id in &found {
        sqlx::query("INSERT INTO post_image_links(post_slug,image_id) VALUES($1,$2)")
            .bind(&slug)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE post_images SET attached_at=coalesce(attached_at,now()) WHERE id=ANY($1)")
        .bind(&found)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM post_file_links WHERE post_slug=$1")
        .bind(&slug)
        .execute(&mut *tx)
        .await?;
    for id in &file_found {
        sqlx::query("INSERT INTO post_file_links(post_slug,file_id) VALUES($1,$2)")
            .bind(&slug)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE post_files SET attached_at=coalesce(attached_at,now()) WHERE id=ANY($1)")
        .bind(&file_found)
        .execute(&mut *tx)
        .await?;
    admin::audit(&mut tx,Some(actor),"post.save","post",&slug,json!({"before":before,"after":{"content":content,"published":v.published,"revision":revision}})).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true,"revision":revision})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    guide_slug: String,
}
pub async fn settings(State(app): State<App>) -> Result<Json<Value>> {
    let guide: String = sqlx::query_scalar(
        "SELECT coalesce(guide_slug,'start') FROM site_settings WHERE singleton",
    )
    .fetch_one(&app.db)
    .await?;
    Ok(Json(json!({"guide_slug":guide})))
}
pub async fn save_settings(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Settings>,
) -> Result<Json<Value>> {
    let actor = admin::require(&app, &h).await?;
    let mut tx = app.db.begin().await?;
    let before: Option<String> =
        sqlx::query_scalar("SELECT guide_slug FROM site_settings WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM content_posts WHERE slug=$1 AND published AND coalesce(content->>'kind','example')='example')").bind(&v.guide_slug).fetch_one(&mut *tx).await?;
    if !allowed {
        return Err(bad("공개된 기본 예제를 선택해 주세요."));
    }
    sqlx::query("UPDATE site_settings SET guide_slug=$1 WHERE singleton")
        .bind(&v.guide_slug)
        .execute(&mut *tx)
        .await?;
    admin::audit(
        &mut tx,
        Some(actor),
        "site.guide",
        "site",
        "guide",
        json!({"before":before,"after":v.guide_slug}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn seed(db: &PgPool) -> anyhow::Result<()> {
    let posts: Vec<Value> = serde_json::from_str(include_str!("content-seed.json"))?;
    for p in posts {
        sqlx::query("INSERT INTO content_posts(slug,content,published) VALUES($1,$2,true) ON CONFLICT(slug) DO NOTHING")
        .bind(p["id"].as_str().unwrap()).bind(&p).execute(db).await?;
    }
    Ok(())
}
