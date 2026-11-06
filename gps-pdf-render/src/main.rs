//! Isolated PDF page rasterizer for reviewed disclosure.
//!
//! One request per process. A stored PDF and a page number arrive on stdin; that page leaves
//! on stdout as opaque RGB inside the delivery limits. Before the first input byte is read the
//! process gives up what it does not need (see `sandbox`): it can no longer open a file, reach
//! a network, start a program, or use more than its memory and CPU ceilings. The API only ever
//! sees the fixed-layout reply, which it checks by length.
//!
//!   gps-pdf-render            serve one request (stdin -> stdout)
//!   gps-pdf-render selftest   prove on this kernel that the sandbox holds and a page renders
mod protocol;
mod render;
mod sandbox;

use protocol::{Request, Status};
use std::io::{stdin, stdout};

fn serve() -> i32 {
    // Never touch input without the sandbox.
    if sandbox::enter(sandbox::CPU_SECONDS).is_err() {
        return 70;
    }
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = match Request::read(&mut stdin().lock()) {
        Ok(request) => {
            std::panic::catch_unwind(|| render::page(&request)).unwrap_or(Err(Status::Failed))
        }
        Err(status) => Err(status),
    };
    match protocol::reply(&mut stdout().lock(), &outcome) {
        Ok(()) => 0,
        Err(_) => 74,
    }
}

fn main() {
    let code = match std::env::args().nth(1).as_deref() {
        None => serve(),
        Some("selftest") => sandbox::selftest(render::sample_renders),
        Some(_) => 64,
    };
    std::process::exit(code);
}
