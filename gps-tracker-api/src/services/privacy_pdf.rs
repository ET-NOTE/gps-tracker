//! Client for the isolated PDF page rasterizer (`gps-pdf-render`).
//!
//! The API never parses a PDF. One renderer process handles one page; the API waits a bounded
//! time and accepts only a fixed-layout reply whose length matches the size it declares. The
//! renderer confines itself before it reads input: no file, network or process system calls, and
//! memory and CPU ceilings.
//!
//! The renderer is reached in one of two ways:
//!
//! * `GPS_PDF_SOCKET` set: the request goes to that Unix socket. A separate service starts the
//!   renderer per connection under its own account, with no network and nothing of the API's
//!   files. That service proves the renderer's confinement in its own environment before its
//!   socket exists, so a socket that accepts is the proof.
//! * otherwise: the API starts the renderer as a child with an empty environment and two pipes.
//!   Before the first use it runs the renderer's self-test, which proves the confinement on this
//!   kernel; without a passing self-test PDF sources stay unavailable.
use super::privacy_raster::{Normalized, PdfSource};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
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
const MAX_PDF: usize = 5 * 1024 * 1024;

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

/// The socket of the separate renderer service, when the API is configured to use one.
fn socket() -> Option<PathBuf> {
    std::env::var_os("GPS_PDF_SOCKET")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    // Nothing of the API's environment, working directory or diagnostics reaches the renderer.
    command
        .env_clear()
        .current_dir("/")
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

/// Renderer path and SHA-256 once the renderer may be used on this host. A failure is not
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
            if socket().is_some() {
                // The service runs this same file and has proven it where it runs. The API
                // cannot repeat that proof from outside; it only names the renderer it records.
                return Ok((path, digest));
            }
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
            (8, 12) => PdfError::Busy,
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
    if pdf.is_empty() || pdf.len() > MAX_PDF {
        return Err(PdfError::Invalid);
    }
    // Also cover self-test initialization, which can otherwise outlive admission.
    let _permit = LIMIT.try_acquire().map_err(|_| PdfError::Busy)?;
    let (path, digest) = renderer().await?;
    let mut request = Vec::with_capacity(16 + pdf.len());
    request.extend_from_slice(MAGIC);
    request.extend_from_slice(&page.to_be_bytes());
    request.extend_from_slice(&(pdf.len() as u32).to_be_bytes());
    request.extend_from_slice(pdf);
    let reply = match socket() {
        Some(address) => through_service(&address, &request).await?,
        None => through_child(path, &request).await?,
    };
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

/// One request to the separate renderer service. The service starts one renderer for this
/// connection; a renderer that is stopped by a limit simply ends the reply early, which `parse`
/// rejects.
async fn through_service(address: &Path, request: &[u8]) -> Result<Vec<u8>, PdfError> {
    let exchange = async {
        let stream = UnixStream::connect(address)
            .await
            .map_err(|_| PdfError::Unavailable)?;
        let (reader, mut writer) = stream.into_split();
        let send = async {
            // The renderer may stop reading early (bad document); that is its answer, not ours.
            let _ = writer.write_all(request).await;
            let _ = writer.shutdown().await;
        };
        let mut reply = Vec::new();
        let mut limited = reader.take(REPLY_LIMIT);
        let (_, received) = tokio::join!(send, limited.read_to_end(&mut reply));
        // A busy supervisor intentionally closes without consuming a document.
        // Unix sockets may then report reset after the complete rejection frame.
        // Accept only that exact bounded error frame, never a partial success.
        if received.is_err() && parse(&reply) != Err(PdfError::Busy) {
            return Err(PdfError::Failed);
        }
        Ok::<_, PdfError>(reply)
    };
    // Dropping the connection at the deadline ends the exchange; the service has its own limits.
    tokio::time::timeout(DEADLINE, exchange)
        .await
        .unwrap_or(Err(PdfError::Failed))
}

/// One request to a renderer the API starts itself.
async fn through_child(path: &Path, request: &[u8]) -> Result<Vec<u8>, PdfError> {
    let mut child = command(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| PdfError::Unavailable)?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(PdfError::Failed);
    };
    let exchange = async {
        let send = async {
            // The renderer may stop reading early (bad document); that is its answer, not ours.
            let _ = stdin.write_all(request).await;
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
    Ok(reply)
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

    #[tokio::test]
    async fn busy_service_rejects_before_consuming_large_request() {
        let address =
            std::env::temp_dir().join(format!("gps-pdf-busy-{}.sock", uuid::Uuid::new_v4()));
        let listener = tokio::net::UnixListener::bind(&address).unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(&reply(&[8], &[])).await.unwrap();
        });
        let response = through_service(&address, &vec![0; MAX_PDF]).await.unwrap();
        assert_eq!(parse(&response), Err(PdfError::Busy));
        task.await.unwrap();
        std::fs::remove_file(address).unwrap();
    }

    #[tokio::test]
    async fn dropping_service_exchange_closes_the_socket() {
        let address =
            std::env::temp_dir().join(format!("gps-pdf-cancel-{}.sock", uuid::Uuid::new_v4()));
        let listener = tokio::net::UnixListener::bind(&address).unwrap();
        let client = tokio::spawn({
            let address = address.clone();
            async move { through_service(&address, b"bounded request").await }
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        server.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"bounded request");
        client.abort();
        assert!(client.await.unwrap_err().is_cancelled());
        // The cancelled future drops both halves; it cannot leave a detached
        // writer/socket holding the renderer alive.
        assert!(server.write_all(b"reply").await.is_err());
        std::fs::remove_file(address).unwrap();
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
            (8, PdfError::Busy),
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

    /// A stand-in for the renderer service: one connection, the whole request in, `answer` out.
    async fn service(answer: Vec<u8>) -> (PathBuf, tokio::task::JoinHandle<Vec<u8>>) {
        let address =
            std::env::temp_dir().join(format!("gps-pdf-test-{}.sock", uuid::Uuid::new_v4()));
        let listener = tokio::net::UnixListener::bind(&address).unwrap();
        let seen = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.unwrap();
            stream.write_all(&answer).await.unwrap();
            request
        });
        (address, seen)
    }

    #[tokio::test]
    async fn the_service_gets_the_whole_request_and_only_a_complete_reply_counts() {
        let request = [
            MAGIC.as_slice(),
            &2u32.to_be_bytes(),
            &3u32.to_be_bytes(),
            b"pdf",
        ]
        .concat();
        let ok = reply(&[0, 2, 1, 7, 595_276, 841_890], &[1, 2, 3, 4, 5, 6]);
        let (address, seen) = service(ok.clone()).await;
        let answer = through_service(&address, &request).await.unwrap();
        assert_eq!(seen.await.unwrap(), request);
        assert_eq!(answer, ok);
        assert_eq!(parse(&answer).unwrap().rgb, [1, 2, 3, 4, 5, 6]);
        std::fs::remove_file(&address).unwrap();

        // A renderer stopped by a limit ends the reply early: nothing, or a cut-off image.
        for cut in [Vec::new(), ok[..ok.len() - 1].to_vec()] {
            let (address, seen) = service(cut).await;
            let answer = through_service(&address, &request).await.unwrap();
            seen.await.unwrap();
            assert_eq!(parse(&answer), Err(PdfError::Failed));
            std::fs::remove_file(&address).unwrap();
        }

        // No service: PDF sources are unavailable, nothing else.
        assert_eq!(
            through_service(&address, &request).await,
            Err(PdfError::Unavailable)
        );
    }
}
