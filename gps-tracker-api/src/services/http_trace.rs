//! Never put request URLs in tracing spans: WebSocket credentials, shared links and reset
//! links can contain secrets even when headers and bodies are excluded.
use axum::extract::Request;

pub fn span(request: &Request) -> tracing::Span {
    // Extension methods are attacker-controlled too. Only known method names enter the log.
    let method = match request.method().as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    };
    tracing::info_span!("http_request", method)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> MakeWriter<'a> for Capture {
        type Writer = Self;
        fn make_writer(&'a self) -> Self {
            self.clone()
        }
    }

    #[test]
    fn request_context_never_logs_url_headers_or_extension_method() {
        let output = Capture(Arc::default());
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .without_time()
            .with_writer(output.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            for method in ["GET", "secret-extension-method"] {
                let request = Request::builder()
                    .method(method)
                    .uri("/share/secret-path?token=secret-query")
                    .header("authorization", "Bearer secret-header")
                    .header("referer", "https://example.invalid/secret-referrer")
                    .body(axum::body::Body::empty())
                    .unwrap();
                let span = span(&request);
                let _guard = span.enter();
                tracing::error!(status = 503, "request failed");
            }
        });
        let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
        assert!(text.contains("GET") && text.contains("OTHER") && text.contains("503"));
        assert!(!text.contains("secret-") && !text.contains("/share/"));
    }
}
