use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    categories: Vec<String>,
    lessons: BTreeMap<String, Vec<String>>,
    revision: i32,
}

pub async fn list(State(app): State<App>) -> Result<Json<Value>> {
    // Filter in one database statement so drafts/renamed categories cannot leak.
    let result: Value = sqlx::query_scalar("WITH published AS (SELECT slug,coalesce(nullif(btrim(content->>'category'),''),'기타') AS category FROM content_posts WHERE published AND coalesce(content->>'kind','example')='example') SELECT jsonb_build_object('categories',coalesce((SELECT jsonb_agg(c.value ORDER BY c.ord) FROM jsonb_array_elements_text(o.content->'categories') WITH ORDINALITY c(value,ord) WHERE EXISTS(SELECT 1 FROM published p WHERE p.category=c.value)),'[]'::jsonb),'lessons',coalesce((SELECT jsonb_object_agg(g.key,g.ids) FROM (SELECT e.key,jsonb_agg(i.value ORDER BY i.ord) AS ids FROM jsonb_each(o.content->'lessons') e CROSS JOIN LATERAL jsonb_array_elements_text(e.value) WITH ORDINALITY i(value,ord) JOIN published p ON p.slug=i.value AND p.category=e.key GROUP BY e.key) g),'{}'::jsonb)) FROM library_order o WHERE singleton")
        .fetch_one(&app.db).await?;
    Ok(Json(result))
}

pub async fn admin_list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin::require(&app, &h).await?;
    let value: Value = sqlx::query_scalar("SELECT content || jsonb_build_object('revision',revision) FROM library_order WHERE singleton")
        .fetch_one(&app.db).await?;
    Ok(Json(value))
}

pub async fn save(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Edit>,
) -> Result<Json<Value>> {
    let actor = admin::require(&app, &h).await?;
    auth::rate(&app, format!("library-order:{actor}"), 60).await?;
    let valid_category = |s: &str| {
        !s.is_empty()
            && s == s.trim()
            && s.chars().count() <= 40
            && !s.chars().any(char::is_control)
    };
    let mut categories = HashSet::new();
    let mut ids = HashSet::new();
    if v.revision < 0
        || v.categories.len() > 500
        || v.lessons.len() > 500
        || v.categories
            .iter()
            .any(|c| !valid_category(c) || !categories.insert(c))
        || v.lessons.iter().any(|(c, lessons)| {
            !valid_category(c)
                || !categories.contains(c)
                || lessons.len() > 1000
                || lessons.iter().any(|id| {
                    id.is_empty()
                        || id.len() > 64
                        || !id
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                        || !ids.insert(id)
                })
        })
        || ids.len() > 5000
    {
        return Err(bad("중복 없는 카테고리·강의 순서를 확인해 주세요."));
    }
    let mut tx = app.db.begin().await?;
    // Same first lock as content::save: category membership cannot change mid-save.
    sqlx::query("SELECT singleton FROM site_settings WHERE singleton FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let before: Value = sqlx::query_scalar("SELECT content || jsonb_build_object('revision',revision) FROM library_order WHERE singleton FOR UPDATE")
        .fetch_one(&mut *tx).await?;
    if before["revision"].as_i64() != Some(i64::from(v.revision)) {
        return Err(Error(
            StatusCode::CONFLICT,
            "다른 관리자가 순서를 수정했습니다. 다시 불러온 뒤 저장해 주세요.".into(),
        ));
    }
    let published: Vec<(String, String)> = sqlx::query_as("SELECT slug,coalesce(nullif(btrim(content->>'category'),''),'기타') FROM content_posts WHERE published AND coalesce(content->>'kind','example')='example'")
        .fetch_all(&mut *tx).await?;
    if v.categories
        .iter()
        .any(|c| !published.iter().any(|(_, category)| category == c))
        || v.lessons.iter().any(|(c, lessons)| {
            lessons.iter().any(|id| {
                !published
                    .iter()
                    .any(|(slug, category)| slug == id && category == c)
            })
        })
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "강의 공개 상태나 카테고리가 변경되었습니다. 다시 불러온 뒤 순서를 확인해 주세요."
                .into(),
        ));
    }
    let content = json!({"categories":v.categories,"lessons":v.lessons});
    let revision: i32 = sqlx::query_scalar("UPDATE library_order SET content=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE singleton RETURNING revision")
        .bind(&content).bind(actor).fetch_one(&mut *tx).await?;
    let after = json!({"categories":v.categories,"lessons":v.lessons,"revision":revision});
    admin::audit(
        &mut tx,
        Some(actor),
        "library.order",
        "library",
        "examples",
        json!({"before":before,"after":after}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(after))
}
