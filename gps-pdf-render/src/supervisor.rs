//! Trusted lifetime supervisor; never reads document bytes or renders a page.
//! The lock is shared by every socket instance and inherited by the worker. It
//! cannot be released by a dropped API request, or by a supervisor dying first.
use crate::protocol::{self, Status};
use std::{
    fs::OpenOptions,
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    time::{Duration, Instant},
};

const LOCK: &str = "/run/gps-pdf-budget/render.lock";
const DEADLINE: Duration = Duration::from_secs(13);

fn refuse(status: Status) -> i32 {
    let _ = protocol::reply(&mut io::stdout().lock(), &Err(status));
    0
}

pub fn serve() -> i32 {
    // This mode is only for the systemd AF_UNIX stream socket, never pipes.
    let mut kind = 0i32;
    let mut domain = 0i32;
    let mut length = std::mem::size_of_val(&kind) as libc::socklen_t;
    // SAFETY: scalar prctl arguments and valid getsockopt output pointers.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0
        || unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) } != 0
        || unsafe {
            libc::getsockopt(
                0,
                libc::SOL_SOCKET,
                libc::SO_TYPE,
                (&mut kind as *mut i32).cast(),
                &mut length,
            )
        } != 0
        || kind != libc::SOCK_STREAM
        || unsafe {
            libc::getsockopt(
                0,
                libc::SOL_SOCKET,
                libc::SO_DOMAIN,
                (&mut domain as *mut i32).cast(),
                &mut length,
            )
        } != 0
        || domain != libc::AF_UNIX
    {
        return 70;
    }
    let lock = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(LOCK)
    {
        Ok(file) => file,
        Err(_) => return 70,
    };
    match lock.metadata() {
        Ok(meta)
            if meta.is_file()
                && meta.uid() == 0
                && meta.mode() & 0o022 == 0
                && meta.nlink() == 1
                && meta.len() == 0 => {}
        _ => return 70,
    }
    // SAFETY: valid descriptor. Nonblocking: never queue unbounded PDF buffers.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return if io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK) {
            refuse(Status::Busy)
        } else {
            70
        };
    }
    // No threads have been started in this executable. The child inherits the
    // lock's open file description and keeps it until it exits, including SIGKILL.
    // SAFETY: fork before any threads, then fixed child setup and the sandbox.
    let parent = unsafe { libc::getpid() };
    let child = unsafe { libc::fork() };
    if child < 0 {
        return 70;
    }
    if child == 0 {
        // Close the race where the parent dies between fork and prctl.
        // SAFETY: scalar system calls; _exit never runs parent destructors.
        if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0
            || unsafe { libc::getppid() } != parent
        {
            unsafe { libc::_exit(70) };
        }
        unsafe { libc::_exit(crate::serve()) };
    }
    let started = Instant::now();
    let mut state = 0;
    loop {
        // SAFETY: the one child PID and valid wait status pointer.
        let waited = unsafe { libc::waitpid(child, &mut state, libc::WNOHANG) };
        if waited == child {
            return 0;
        }
        if waited < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return 70;
        }
        // A normal request half-closes its write side to delimit the PDF. That
        // is RDHUP, NOT HUP. Only a full peer close cancels rendering.
        let mut socket = libc::pollfd {
            fd: 0,
            events: 0,
            revents: 0,
        };
        // SAFETY: valid one-element poll buffer, bounded 20 ms wait.
        let polled = unsafe { libc::poll(&mut socket, 1, 20) };
        let failed = polled < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR);
        if failed
            || started.elapsed() >= DEADLINE
            || socket.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0
        {
            // Keep the shared lock until the worker is reaped. On abrupt parent
            // death PDEATHSIG and the inherited lock preserve this same ordering.
            // SAFETY: signal and reap only the child created above.
            unsafe { libc::kill(child, libc::SIGKILL) };
            loop {
                let waited = unsafe { libc::waitpid(child, &mut state, 0) };
                if waited == child {
                    break;
                }
                if waited < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                    break;
                }
            }
            return 0;
        }
    }
}
