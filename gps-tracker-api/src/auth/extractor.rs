use axum::{async_trait, extract::FromRequestParts, http::request::Parts};

use crate::{auth::jwt, error::AppError, state::AppState};

#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub user_id: i64,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(scope) = parts.extensions.get::<super::fleet::FleetScope>() {
            require_existing_account(state, scope.actor).await?;
            require_existing_account(state, scope.owner).await?;
            return Ok(AuthUser {
                user_id: scope.owner,
            });
        }
        let header = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;

        let token = header
            .strip_prefix("Bearer ")
            .ok_or(AppError::Unauthorized)?;

        let claims = jwt::verify(token, &state.config.jwt_secret, "access")
            .map_err(|_| AppError::Unauthorized)?;

        if crate::services::admin_security::enabled() && claims.act.is_some() {
            return Err(AppError::Forbidden);
        }
        let user_id: i64 = claims.sub.parse().map_err(|_| AppError::Unauthorized)?;
        require_existing_account(state, user_id).await?;
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

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        crate::services::admin_security::require(parts, state).await?;
        if parts.extensions.get::<super::fleet::FleetScope>().is_some() {
            return Err(AppError::Forbidden);
        }
        let auth = AuthUser::from_request_parts(parts, state).await?;
        let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = $1")
            .bind(auth.user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(AppError::from)?;
        if role.as_deref() != Some("admin") {
            return Err(AppError::Forbidden);
        }
        Ok(AdminUser {
            user_id: auth.user_id,
        })
    }
}

// A still-valid JWT does not keep a deleted account alive.
pub async fn require_existing_account(state: &AppState, user_id: i64) -> Result<(), AppError> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.id=$1 AND NOT c.restricted)")
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    if exists {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
}
