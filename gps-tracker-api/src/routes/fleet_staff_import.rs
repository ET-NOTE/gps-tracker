//! CSV is parsed in the browser; all values, duplicates and permissions are
//! checked again here under the same lock as individual staff edits.
use super::*;
use serde::Serialize;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportRow {
    name: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    department: String,
    #[serde(default)]
    position: String,
    #[serde(default)]
    role: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportInput {
    rows: Vec<ImportRow>,
    #[serde(default)]
    confirm: bool,
    token: Option<String>,
}
fn phone_key(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}
fn normalize(r: ImportRow) -> ImportRow {
    ImportRow {
        name: r.name.trim().into(),
        phone: r.phone.trim().into(),
        department: r.department.trim().into(),
        position: r.position.trim().into(),
        role: r.role.trim().into(),
    }
}
fn problems(r: &ImportRow) -> Vec<String> {
    let mut errors = Vec::new();
    for (label, value, max) in [
        ("이름", &r.name, 64),
        ("연락처", &r.phone, 50),
        ("부서", &r.department, 100),
        ("직책", &r.position, 100),
        ("담당 업무", &r.role, 100),
    ] {
        if value.chars().count() > max || value.chars().any(char::is_control) {
            errors.push(format!("{label}: {max}자 이내의 한 줄로 입력하세요."));
        }
    }
    if r.name.is_empty() {
        errors.push("이름을 입력하세요.".into());
    }
    if !r.phone.is_empty()
        && (phone_key(&r.phone).is_empty()
            || r.phone
                .chars()
                .any(|c| !c.is_ascii_digit() && !" +-()".contains(c)))
    {
        errors.push("연락처에는 숫자와 +, -, 괄호만 사용하세요.".into());
    }
    errors
}

pub(super) async fn import(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<ImportInput>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    if p.rows.is_empty() || p.rows.len() > 500 {
        return Err(AppError::BadRequest(
            "한 번에 1~500명을 등록해 주세요.".into(),
        ));
    }
    let rows: Vec<_> = p.rows.into_iter().map(normalize).collect();
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let existing:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'phone',phone,'updated_at',updated_at) FROM staff WHERE user_id=$1 ORDER BY id")
        .bind(s.owner).fetch_all(&mut *tx).await?;
    let org: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(i) FROM fleet_org_items i WHERE owner_id=$1 ORDER BY id",
    )
    .bind(s.owner)
    .fetch_all(&mut *tx)
    .await?;
    let mut seen: Vec<(String, String)> = Vec::new();
    let mut preview = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let mut errors = problems(r);
        let mut ids = [None, None];
        for (j, kind, label, name) in [
            (0, "department", "부서", &r.department),
            (1, "position", "직책", &r.position),
        ] {
            if !name.is_empty() {
                ids[j] = org
                    .iter()
                    .find(|v| {
                        v["kind"] == kind && v["name"] == name.as_str() && v["active"] == true
                    })
                    .and_then(|v| v["id"].as_i64());
                if ids[j].is_none() {
                    errors.push(format!(
                        "{label} ‘{name}’을 부서·직책 메뉴에 먼저 등록하세요."
                    ));
                }
            }
        }
        let key = phone_key(&r.phone);
        let duplicate = existing.iter().any(|v| {
            v["name"].as_str().unwrap_or("").trim() == r.name
                && phone_key(v["phone"].as_str().unwrap_or("")) == key
        });
        let repeated = seen
            .iter()
            .any(|(name, phone)| name == &r.name && phone == &key);
        if !key.is_empty()
            && (existing.iter().any(|v| {
                phone_key(v["phone"].as_str().unwrap_or("")) == key
                    && v["name"].as_str().unwrap_or("").trim() != r.name
            }) || seen
                .iter()
                .any(|(name, phone)| phone == &key && name != &r.name))
        {
            errors.push("같은 연락처에 다른 이름이 있습니다. 확인 후 수정하세요.".into());
        }
        let status = if !errors.is_empty() {
            "error"
        } else if duplicate || repeated {
            "skip"
        } else {
            "ready"
        };
        preview.push(json!({"row":i+2,"name":r.name,"phone":r.phone,"department":r.department,"position":r.position,"role":r.role,
            "department_id":ids[0],"position_id":ids[1],"status":status,"errors":errors,
            "message":if duplicate{"기존 등록 유지"}else if repeated{"파일 내 중복 제외"}else{""}}));
        seen.push((r.name.clone(), key));
    }
    let ready = preview.iter().filter(|r| r["status"] == "ready").count();
    let errors = preview.iter().filter(|r| r["status"] == "error").count();
    let skipped = preview.len() - ready - errors;
    // Bind confirmation to both submitted values and the current company state.
    let token = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([s.owner, s.actor, rows, existing, org]))
                .map_err(|e| AppError::Internal(e.into()))?
        )
    );
    let mut created = Vec::new();
    if p.confirm {
        if p.token.as_deref() != Some(&token) {
            return Err(AppError::Conflict(
                "사용자 또는 조직 정보가 변경됐습니다. 미리보기를 다시 확인해 주세요.".into(),
            ));
        }
        if errors > 0 {
            return Err(AppError::BadRequest(
                "오류가 있는 행을 수정한 뒤 다시 확인해 주세요. 아직 등록된 행은 없습니다.".into(),
            ));
        }
        for r in preview.iter().filter(|r| r["status"] == "ready") {
            let id:i64=sqlx::query_scalar("INSERT INTO staff(user_id,name,phone,role,department_id,position_id,access_role,all_vehicles,active) VALUES($1,$2,nullif($3,''),nullif($4,''),$5,$6,'member',false,true) RETURNING id")
                .bind(s.owner).bind(r["name"].as_str()).bind(r["phone"].as_str()).bind(r["role"].as_str())
                .bind(r["department_id"].as_i64()).bind(r["position_id"].as_i64()).fetch_one(&mut *tx).await?;
            created.push(id);
        }
        if !created.is_empty() {
            log(
                &mut tx,
                s.owner,
                s.actor,
                "staff_import",
                0,
                Value::Null,
                json!({"staff_ids":created,"created":created.len(),"skipped":skipped}),
            )
            .await?;
        }
        tx.commit().await?;
    } // Preview transaction rolls back without writing staff or invitations.
    Ok(Json(
        json!({"rows":preview,"ready":ready,"errors":errors,"skipped":skipped,"token":token,"created":created}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_fields_cannot_grant_privileges() {
        assert!(
            serde_json::from_value::<ImportRow>(json!({"name":"A","access_role":"admin"})).is_err()
        );
        assert!(serde_json::from_value::<ImportInput>(json!({"rows":[],"owner_id":99})).is_err());
    }
    #[test]
    fn import_normalizes_and_validates_contact() {
        let r: ImportRow =
            serde_json::from_value(json!({"name":" A ","phone":"010-1234-5678"})).unwrap();
        let mut r = normalize(r);
        assert_eq!(r.name, "A");
        assert_eq!(phone_key(&r.phone), "01012345678");
        assert!(problems(&r).is_empty());
        r.name = "A\nB".into();
        r.phone = "abc".into();
        assert_eq!(problems(&r).len(), 2);
    }
}
