//! Encrypted at-rest uploads. Authorization stays in the calling route.
//! Context uses the configured root role + relative path, so a backup can move roots.
use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;
use std::path::{Component, Path, PathBuf};
const MAGIC: &[u8] = b"GPSFILE1\n";
const LIMIT: usize = 10 * 1024 * 1024;
const STORED_LIMIT: usize = LIMIT * 2 + 65536;
fn invalid() -> AppError {
    AppError::Conflict(
        "파일을 확인할 수 없습니다. 다시 시도하거나 관리자에게 문의해 주세요.".into(),
    )
}
fn roots() -> [(String, PathBuf); 2] {
    let uploads =
        PathBuf::from(std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "/home/mmm/uploads".into()));
    let private = std::env::var("PRIVATE_UPLOAD_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| uploads.with_file_name("gps-private-uploads"));
    [("private".into(), private), ("uploads".into(), uploads)]
}
fn context(path: &Path) -> AppResult<(String, PathBuf, Vec<String>)> {
    for (role, root) in roots() {
        if let Ok(relative) = path.strip_prefix(&root) {
            let parts = relative
                .components()
                .map(|c| match c {
                    Component::Normal(s) => s.to_str().map(str::to_owned),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(invalid)?;
            if parts.is_empty() {
                return Err(invalid());
            }
            return Ok((
                serde_json::json!(["gps-file-v1", role, parts]).to_string(),
                root,
                parts,
            ));
        }
    }
    Err(invalid())
}
async fn policy(db: &PgPool) -> AppResult<bool> {
    Ok(
        sqlx::query_scalar("SELECT enabled FROM location_storage_policy WHERE singleton")
            .fetch_one(db)
            .await?,
    )
}
pub async fn decode(db: &PgPool, path: &Path, stored: Vec<u8>) -> AppResult<Vec<u8>> {
    let (ctx, _, _) = context(path)?;
    if stored.len() > STORED_LIMIT {
        return Err(invalid());
    }
    if let Some(payload) = stored.strip_prefix(MAGIC) {
        let envelope: serde_json::Value = serde_json::from_slice(payload).map_err(|_| invalid())?;
        let plain: serde_json::Value = sqlx::query_scalar("SELECT gps_open_cell($1,$2)")
            .bind(envelope)
            .bind(ctx)
            .fetch_one(db)
            .await
            .map_err(|_| invalid())?;
        let result = STANDARD
            .decode(plain.as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        if result.len() > LIMIT {
            return Err(invalid());
        }
        return Ok(result);
    }
    // ON never silently accepts legacy plaintext or a damaged magic header.
    if policy(db).await? || stored.len() > LIMIT {
        return Err(invalid());
    }
    Ok(stored)
}
pub async fn read(db: &PgPool, path: impl AsRef<Path>) -> AppResult<Vec<u8>> {
    let path = path.as_ref().to_owned();
    let (_, root, parts) = context(&path)?;
    let stored = tokio::task::spawn_blocking(move || safe_read(root, parts))
        .await
        .map_err(|_| invalid())??;
    decode(db, &path, stored).await
}
#[cfg(unix)]
fn safe_read(root: PathBuf, parts: Vec<String>) -> AppResult<Vec<u8>> {
    use std::{
        fs::{File, OpenOptions},
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
    };
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|_| invalid())?;
    for (i, part) in parts.iter().enumerate() {
        let name = std::ffi::CString::new(part.as_bytes()).map_err(|_| invalid())?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if i + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        // SAFETY: owned directory descriptor and valid NUL-terminated path component.
        let fd = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(invalid());
        }
        // SAFETY: unique ownership of the newly opened descriptor.
        file = unsafe { File::from_raw_fd(fd) };
    }
    let m = file.metadata().map_err(|_| invalid())?;
    if !m.is_file() || m.nlink() != 1 || m.len() > STORED_LIMIT as u64 {
        return Err(invalid());
    }
    let mut result = Vec::new();
    file.take(STORED_LIMIT as u64 + 1)
        .read_to_end(&mut result)
        .map_err(|_| invalid())?;
    if result.len() > STORED_LIMIT {
        return Err(invalid());
    }
    Ok(result)
}
#[cfg(not(unix))]
fn safe_read(_: PathBuf, _: Vec<String>) -> AppResult<Vec<u8>> {
    Err(invalid())
}
pub async fn write(db: &PgPool, path: impl AsRef<Path>, bytes: &[u8]) -> AppResult<()> {
    let path = path.as_ref();
    let (ctx, root, parts) = context(path)?;
    if bytes.len() > LIMIT {
        return Err(invalid());
    }
    let maintenance: bool =
        sqlx::query_scalar("SELECT maintenance FROM location_storage_policy WHERE singleton")
            .fetch_one(db)
            .await?;
    if maintenance {
        return Err(invalid());
    }
    let data = if policy(db).await? {
        let sealed: serde_json::Value =
            sqlx::query_scalar("SELECT gps_seal_cell(to_jsonb($1::text),$2)")
                .bind(STANDARD.encode(bytes))
                .bind(ctx)
                .fetch_one(db)
                .await?;
        let mut data = MAGIC.to_vec();
        data.extend(serde_json::to_vec(&sealed).map_err(|_| invalid())?);
        data
    } else {
        bytes.to_vec()
    };
    tokio::task::spawn_blocking(move || safe_write(root, parts, data))
        .await
        .map_err(|_| invalid())?
}
#[cfg(unix)]
fn safe_write(root: PathBuf, parts: Vec<String>, data: Vec<u8>) -> AppResult<()> {
    use std::{
        fs::{File, OpenOptions},
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        },
    };
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|_| invalid())?;
    for part in &parts[..parts.len() - 1] {
        let name = std::ffi::CString::new(part.as_bytes()).map_err(|_| invalid())?;
        // SAFETY: owned directory descriptor, validated single component.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(invalid());
        }
        // SAFETY: unique ownership of the new descriptor.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    let name = std::ffi::CString::new(parts.last().ok_or_else(invalid)?.as_bytes())
        .map_err(|_| invalid())?;
    // SAFETY: exclusive creation relative to the already opened parent, without symlink following.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(invalid());
    }
    // SAFETY: unique ownership of the new descriptor.
    let mut file = unsafe { File::from_raw_fd(fd) };
    if let Err(e) = file
        .write_all(&data)
        .and_then(|_| file.sync_all())
        .and_then(|_| directory.sync_all())
    {
        // SAFETY: same pinned parent and filename used to create this file.
        unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) };
        return Err(AppError::Internal(e.into()));
    }
    Ok(())
}
#[cfg(not(unix))]
fn safe_write(_: PathBuf, _: Vec<String>, _: Vec<u8>) -> AppResult<()> {
    Err(invalid())
}
