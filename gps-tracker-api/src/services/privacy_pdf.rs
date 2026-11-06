//! Client for the isolated PDF page rasterizer (`gps-pdf-render`).
//!
//! The API never parses a PDF. It starts one renderer process per page with an empty
//! environment and two pipes, waits a bounded time, and accepts only a fixed-layout reply whose
//! length matches the size it declares. The renderer confines itself before it reads input: no
//! file, network or process system calls, and memory and CPU ceilings. Before the first use the
//! API runs the renderer's self-test, which proves that confinement on this kernel; without a
//! passing self-test PDF sources stay unavailable.
use super::privacy_raster::{Normalized, PdfSource};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{OnceCell, Semaphore},
};

/// The renderer refuses longer documents; the API refuses the page number before starting it.
pub const MAX_PAGES: u32 = 200;
const MAGIC: &[u8; 8] = b"GPSPDF1\n";
const MAX_SIDE: u32 = 2048;
const MAX_PIXELS: u64 = 1_000_000;
/// Header plus the largest allowed page, plus one byte so an over-long reply is detected.
const REPLY_LIMIT: u64 = 32 + 3 * MAX_PIXELS + 1;
/// Wall clock for one page. The renderer's own CPU ceiling is lower.
const DEADLINE: Duration = Duration::from_secs(15);

#[derive(Debug, PartialEq, Eq)]
pub enum PdfError {
    /// No renderer, or its confinement could not be proven on this host.
    Unavailable,
    /// Another page is being rendered.
    Busy,
    Invalid,
    Encrypted,
    TooManyPages,
    NoSuchPage,
    PageSize,
    /// The renderer ended without a valid reply: a limit was hit or the page is unsupported.
    Failed,
}

#[derive(Debug, PartialEq, Eq)]
struct Reply<'a> {
    width: u32,
    height: u32,
    pages: u32,
    page_width: u32,
    page_height: u32,
    rgb: &'a [u8],
}

fn path() -> PathBuf {
    if let Some(configured) = std::env::var_os("GPS_PDF_RENDERER") {
        return PathBuf::from(configured);
    }
    // Deployed next to the API binary.
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("gps-pdf-render")))
        .unwrap_or_else(|| PathBuf::from("gps-pdf-render"))
}

fn command(path: &std::path::Path) -> Command {
    let mut command = Command::new(path);
    // Nothing of the API's environment, working directory or diagnostics reaches the renderer.
    command
        .env_clear()
        .current_dir("/")
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

/// Renderer path and SHA-256 once its self-test has passed on this host. A failure is not
/// remembered, so a renderer installed later is picked up without a restart.
async fn renderer() -> Result<&'static (PathBuf, String), PdfError> {
    static READY: OnceCell<(PathBuf, String)> = OnceCell::const_new();
    READY
        .get_or_try_init(|| async {
            let path = path();
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|_| PdfError::Unavailable)?;
            let digest = format!("{:x}", Sha256::digest(&bytes));
            let selftest = command(&path)
                .arg("selftest")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .status();
            match tokio::time::timeout(Duration::from_secs(30), selftest).await {
                Ok(Ok(status)) if status.success() => Ok((path, digest)),
                _ => {
                    tracing::error!("PDF renderer self-test failed; PDF sources are unavailable");
                    Err(PdfError::Unavailable)
                }
            }
        })
        .await
}

/// Accepts exactly the layout the renderer documents; anything else is a failure.
fn parse(reply: &[u8]) -> Result<Reply<'_>, PdfError> {
    let word = |at: usize| {
        reply
            .get(at..at + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    if reply.get(..8) != Some(MAGIC.as_slice()) {
        return Err(PdfError::Failed);
    }
    let status = word(8).ok_or(PdfError::Failed)?;
    if status != 0 {
        return Err(match (status, reply.len()) {
            (2, 12) => PdfError::Invalid,
            (3, 12) => PdfError::Encrypted,
            (4, 12) => PdfError::TooManyPages,
            (5, 12) => PdfError::NoSuchPage,
            (6, 12) => PdfError::PageSize,
            _ => PdfError::Failed,
        });
    }
    let (Some(width), Some(height), Some(pages), Some(page_width), Some(page_height)) =
        (word(12), word(16), word(20), word(24), word(28))
    else {
        return Err(PdfError::Failed);
    };
    let inside = (1..=MAX_SIDE).contains(&width)
        && (1..=MAX_SIDE).contains(&height)
        && u64::from(width) * u64::from(height) <= MAX_PIXELS
        && (1..=MAX_PAGES).contains(&pages)
        && page_width > 0
        && page_height > 0;
    let rgb = &reply[32..];
    if !inside || rgb.len() as u64 != 3 * u64::from(width) * u64::from(height) {
        return Err(PdfError::Failed);
    }
    Ok(Reply {
        width,
        height,
        pages,
        page_width,
        page_height,
        rgb,
    })
}

/// One page of a stored PDF as normalized pixels, rendered by the isolated process.
pub async fn render(pdf: &[u8], page: u32) -> Result<Normalized, PdfError> {
    static LIMIT: Semaphore = Semaphore::const_new(1);
    if !(1..=MAX_PAGES).contains(&page) {
        return Err(PdfError::NoSuchPage);
    }
    let (path, digest) = renderer().await?;
    let _permit = LIMIT.try_acquire().map_err(|_| PdfError::Busy)?;
    let mut child = command(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| PdfError::Unavailable)?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(PdfError::Failed);
    };
    let mut request = Vec::with_capacity(16 + pdf.len());
    request.extend_from_slice(MAGIC);
    request.extend_from_slice(&page.to_be_bytes());
    request.extend_from_slice(&(pdf.len() as u32).to_be_bytes());
    request.extend_from_slice(pdf);
    let exchange = async {
        let send = async {
            // The renderer may stop reading early (bad document); that is its answer, not ours.
            let _ = stdin.write_all(&request).await;
            let _ = stdin.shutdown().await;
            drop(stdin);
        };
        let mut reply = Vec::new();
        let mut limited = stdout.take(REPLY_LIMIT);
        let (_, received) = tokio::join!(send, limited.read_to_end(&mut reply));
        received.map_err(|_| PdfError::Failed)?;
        let status = child.wait().await.map_err(|_| PdfError::Failed)?;
        Ok::<_, PdfError>((status.success(), reply))
    };
    let (clean, reply) = match tokio::time::timeout(DEADLINE, exchange).await {
        Ok(outcome) => outcome?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(PdfError::Failed);
        }
    };
    if !clean {
        // Ended by a signal: a resource ceiling or the system-call filter.
        return Err(PdfError::Failed);
    }
    let reply = parse(&reply)?;
    Ok(Normalized {
        width: reply.width,
        height: reply.height,
        rgb: reply.rgb.to_vec(),
        source_width: 0,
        source_height: 0,
        orientation: 1,
        pdf: Some(PdfSource {
            page,
            pages: reply.pages,
            page_width: reply.page_width,
            page_height: reply.page_height,
            renderer_sha256: digest.clone(),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(words: &[u32], rgb: &[u8]) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        for word in words {
            bytes.extend(word.to_be_bytes());
        }
        bytes.extend(rgb);
        bytes
    }

    #[test]
    fn only_the_documented_reply_layout_is_accepted() {
        let ok = reply(&[0, 2, 1, 7, 595_276, 841_890], &[1, 2, 3, 4, 5, 6]);
        let parsed = parse(&ok).unwrap();
        assert_eq!((parsed.width, parsed.height, parsed.pages), (2, 1, 7));
        assert_eq!(parsed.rgb, [1, 2, 3, 4, 5, 6]);
        for (status, error) in [
            (2, PdfError::Invalid),
            (3, PdfError::Encrypted),
            (4, PdfError::TooManyPages),
            (5, PdfError::NoSuchPage),
            (6, PdfError::PageSize),
            (1, PdfError::Failed),
            (7, PdfError::Failed),
            (99, PdfError::Failed),
        ] {
            assert_eq!(parse(&reply(&[status], &[])), Err(error));
        }
        // An error status never carries a payload.
        assert_eq!(parse(&reply(&[3], &[0])), Err(PdfError::Failed));
        for bad in [
            reply(&[0, 2, 1, 7, 1, 1], &[1, 2, 3, 4, 5]), // one byte short
            reply(&[0, 2, 1, 7, 1, 1], &[1, 2, 3, 4, 5, 6, 7]), // one byte long
            reply(&[0, 0, 1, 7, 1, 1], &[]),              // empty image
            reply(&[0, 2049, 1, 7, 1, 1], &[]),           // beyond the side limit
            reply(&[0, 2000, 2000, 7, 1, 1], &[]),        // beyond the pixel limit
            reply(&[0, 2, 1, 0, 1, 1], &[1, 2, 3, 4, 5, 6]), // no pages
            reply(&[0, 2, 1, 201, 1, 1], &[1, 2, 3, 4, 5, 6]), // more pages than allowed
            reply(&[0, 2, 1, 7, 0, 1], &[1, 2, 3, 4, 5, 6]), // impossible page size
            reply(&[0, 2, 1], &[]),                       // truncated header
            b"GPSPDF2\n\0\0\0\0".to_vec(),
            Vec::new(),
        ] {
            assert_eq!(parse(&bad), Err(PdfError::Failed));
        }
    }
}
