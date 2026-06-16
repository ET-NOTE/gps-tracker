use axum::{async_trait, extract::FromRequestParts, http::request::Parts};

use crate::{auth::jwt, error::AppError, state::AppState};

#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub user_id: i64,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;

        let token = header.strip_prefix("Bearer ").ok_or(AppError::Unauthorized)?;

        let claims = jwt::verify(token, &state.config.jwt_secret, "access")
            .map_err(|_| AppError::Unauthorized)?;

        let user_id: i64 = claims.sub.parse().map_err(|_| AppError::Unauthorized)?;
        Ok(AuthUser { user_id })
    }
}

/// users.role = 'admin' 가 아니면 403 Forbidden.
#[derive(Debug, Clone, Copy)]
pub struct AdminUser {
    pub user_id: i64,
}

#[async_trait]
impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let auth = AuthUser::from_request_parts(parts, state).await?;
        let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = $1")
            .bind(auth.user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(AppError::from)?;
        if role.as_deref() != Some("admin") {
            return Err(AppError::Forbidden);
        }
        Ok(AdminUser { user_id: auth.user_id })
    }
}
