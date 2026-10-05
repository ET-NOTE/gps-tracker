use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    category: String,
    thumbnail: Option<images::Thumbnail>,
    revision: i32,
}

pub async fn list(State(app): State<App>) -> Result<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('category',c.category,'thumbnail',jsonb_build_object('id',c.image_id,'alt',c.alt)) FROM category_thumbnails c WHERE c.image_id IS NOT NULL AND EXISTS(SELECT 1 FROM content_posts p WHERE p.published AND coalesce(p.content->>'kind','example')='example' AND coalesce(nullif(btrim(p.content->>'category'),''),'기타')=c.category) ORDER BY c.category")
        .fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}

pub async fn admin_list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin::require(&app, &h).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('category',category,'thumbnail',CASE WHEN image_id IS NULL THEN NULL ELSE jsonb_build_object('id',image_id,'alt',alt) END,'revision',revision) FROM category_thumbnails ORDER BY category")
        .fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}

pub async fn save(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Edit>,
) -> Result<Json<Value>> {
    let actor = admin::require(&app, &h).await?;
    auth::rate(&app, format!("category-thumbnails:{actor}"), 60).await?;
    let category = v.category.trim();
    if category.is_empty()
        || category.chars().count() > 40
        || category.chars().any(char::is_control)
        || v.revision < 0
        || v.thumbnail
            .as_ref()
            .is_some_and(|t| !images::valid_thumbnail(t))
    {
        return Err(bad("카테고리와 썸네일 설명을 확인해 주세요."));
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(8043011)")
        .execute(&mut *tx)
        .await?;
    let before: Option<Value> = sqlx::query_scalar("SELECT jsonb_build_object('category',category,'image_id',image_id,'alt',alt,'revision',revision) FROM category_thumbnails WHERE category=$1 FOR UPDATE")
        .bind(category).fetch_optional(&mut *tx).await?;
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
    if before.is_none() {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM category_thumbnails")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 500 {
            return Err(bad("카테고리 보관 한도에 도달했습니다."));
        }
    }
    let (id, alt) = if let Some(t) = &v.thumbnail {
        let found: Option<String> =
            sqlx::query_scalar("SELECT id FROM post_images WHERE id=$1 FOR KEY SHARE")
                .bind(&t.id)
                .fetch_optional(&mut *tx)
                .await?;
        if found.is_none() {
            return Err(bad(
                "썸네일 사진이 만료되었거나 없습니다. 다시 올려 주세요.",
            ));
        }
        (Some(t.id.as_str()), t.alt.as_str())
    } else {
        (None, "")
    };
    let revision: i32 = sqlx::query_scalar("INSERT INTO category_thumbnails(category,image_id,alt,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(category) DO UPDATE SET image_id=EXCLUDED.image_id,alt=EXCLUDED.alt,updated_by=EXCLUDED.updated_by,updated_at=now(),revision=category_thumbnails.revision+1 RETURNING revision")
        .bind(category).bind(id).bind(alt).bind(actor).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE post_images SET attached_at=coalesce(attached_at,now()) WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    admin::audit(
        &mut tx,
        Some(actor),
        "category.thumbnail",
        "category",
        category,
        json!({"before":before,"after":{"thumbnail":v.thumbnail,"revision":revision}}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"category":category,"thumbnail":v.thumbnail,"revision":revision}),
    ))
}
