//! What this process gives up before it reads a single input byte.
//!
//! * no new privileges (setuid programs cannot raise it again)
//! * resource ceilings: address space, CPU seconds, file size, open files, processes, core dumps
//! * a system-call allowlist: memory management, the already-open pipes, time, exit.
//!   No call that opens a file, creates a socket, starts a program or a process is on it,
//!   and any other call ends the process immediately.
//!
//! The limits cannot be raised again and the filter cannot be removed. `selftest` proves on the
//! running kernel that each forbidden action really ends the process.
use seccompiler::{apply_filter, BpfProgram, SeccompAction, SeccompFilter, TargetArch};
use std::collections::BTreeMap;

/// Address space for one page: document, fonts, decoded images and the pixel buffers.
pub const MEMORY_BYTES: u64 = 768 * 1024 * 1024;
/// CPU seconds. The API also stops waiting on its own wall-clock deadline.
pub const CPU_SECONDS: u64 = 10;

/// Everything the renderer needs once the pipes are open. Nothing here names a file, a socket,
/// a program or another process.
const ALLOWED: &[libc::c_long] = &[
    libc::SYS_read,
    libc::SYS_write,
    libc::SYS_writev,
    libc::SYS_close,
    libc::SYS_mmap,
    libc::SYS_munmap,
    libc::SYS_mremap,
    libc::SYS_mprotect,
    libc::SYS_madvise,
    libc::SYS_brk,
    libc::SYS_futex,
    libc::SYS_getrandom,
    libc::SYS_clock_gettime,
    libc::SYS_sched_yield,
    libc::SYS_rt_sigaction,
    libc::SYS_rt_sigprocmask,
    libc::SYS_rt_sigreturn,
    libc::SYS_sigaltstack,
    // No kill/tkill/tgkill: they could signal other processes of the same user. A failed
    // allocation therefore ends this process through the filter instead of through abort().
    libc::SYS_exit,
    libc::SYS_exit_group,
    libc::SYS_restart_syscall,
];

fn limit(resource: libc::c_int, value: u64) -> Result<(), ()> {
    let limit = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: plain system call with a valid pointer to a local value.
    if unsafe { libc::setrlimit(resource as _, &limit) } == 0 {
        Ok(())
    } else {
        Err(())
    }
}

/// Irreversible. Returns an error when any part could not be applied; the caller must then
/// refuse to process input.
pub fn enter(cpu_seconds: u64) -> Result<(), ()> {
    limit(libc::RLIMIT_AS as _, MEMORY_BYTES)?;
    limit(libc::RLIMIT_CPU as _, cpu_seconds)?;
    limit(libc::RLIMIT_FSIZE as _, 0)?;
    limit(libc::RLIMIT_CORE as _, 0)?;
    limit(libc::RLIMIT_NPROC as _, 0)?;
    limit(libc::RLIMIT_NOFILE as _, 3)?;
    let rules = ALLOWED
        .iter()
        .map(|&call| (call, Vec::new()))
        .collect::<BTreeMap<_, _>>();
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::KillProcess,
        SeccompAction::Allow,
        TargetArch::x86_64,
    )
    .map_err(|_| ())?;
    let program: BpfProgram = filter.try_into().map_err(|_| ())?;
    // Sets no_new_privs, then installs the filter.
    apply_filter(&program).map_err(|_| ())
}

/// One forbidden action per child process. Each child enters the same sandbox as a real request
/// and then tries the action; the parent only looks at how the child ended.
type Probe = (&'static str, fn(), &'static [libc::c_int]);

fn open_file() {
    // SAFETY: valid NUL-terminated path; the call is expected to end the process.
    unsafe { libc::open(c"/etc/passwd".as_ptr(), libc::O_RDONLY) };
}
fn open_socket() {
    // SAFETY: plain system call; expected to end the process.
    unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
}
fn start_program() {
    let argv = [c"/bin/true".as_ptr(), std::ptr::null()];
    // SAFETY: valid NUL-terminated strings and a NULL-terminated argv; expected to end the process.
    unsafe { libc::execv(argv[0], argv.as_ptr()) };
}
fn start_process() {
    // SAFETY: plain system call; expected to end the process.
    unsafe { libc::fork() };
}
fn too_much_memory() {
    // SAFETY: anonymous mapping request with valid arguments; only the result is inspected.
    let mapped = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            (MEMORY_BYTES * 2) as usize,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
            -1,
            0,
        )
    };
    if mapped == libc::MAP_FAILED {
        // SAFETY: ends this child with a status the parent recognises as "refused".
        unsafe { libc::_exit(REFUSED) };
    }
}
fn too_much_cpu() {
    let mut value = 0u64;
    loop {
        value = std::hint::black_box(value.wrapping_add(1));
    }
}

const REFUSED: libc::c_int = 42;
const PROBES: &[Probe] = &[
    ("open_file", open_file, &[libc::SIGSYS]),
    ("open_socket", open_socket, &[libc::SIGSYS]),
    ("start_program", start_program, &[libc::SIGSYS]),
    ("start_process", start_process, &[libc::SIGSYS]),
    ("too_much_memory", too_much_memory, &[]),
    (
        "too_much_cpu",
        too_much_cpu,
        &[libc::SIGXCPU, libc::SIGKILL],
    ),
];

/// Runs a closure in a sandboxed child and reports how the child ended.
fn child(action: impl FnOnce() -> libc::c_int) -> Option<libc::c_int> {
    // SAFETY: this program is single-threaded; the child only runs `action` and exits.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return None;
    }
    if pid == 0 {
        let code = if enter(1).is_ok() { action() } else { 70 };
        // SAFETY: ends the child without running the parent's exit handlers.
        unsafe { libc::_exit(code) };
    }
    let mut status = 0;
    // SAFETY: waits for the child created above with a valid status pointer.
    if unsafe { libc::waitpid(pid, &mut status, 0) } != pid {
        return None;
    }
    Some(status)
}

/// Exit code 0 only when the sandbox holds on this kernel and a page still renders inside it.
/// Prints one line of JSON describing each check.
pub fn selftest(render: fn() -> bool) -> i32 {
    let mut results = Vec::new();
    let mut held = true;
    for (name, probe, signals) in PROBES {
        let status = child(|| {
            probe();
            0 // reaching this line means the action was not stopped
        });
        let (blocked, how) = match status {
            Some(status)
                if libc::WIFSIGNALED(status) && signals.contains(&libc::WTERMSIG(status)) =>
            {
                (true, format!("signal {}", libc::WTERMSIG(status)))
            }
            Some(status) if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == REFUSED => {
                (true, "refused".to_string())
            }
            Some(status) => (false, format!("status {status}")),
            None => (false, "not run".to_string()),
        };
        held &= blocked;
        results.push(format!(
            "\"{name}\":{{\"blocked\":{blocked},\"how\":\"{how}\"}}"
        ));
    }
    let rendered = matches!(child(|| if render() { 0 } else { 1 }), Some(status) if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0);
    println!(
        "{{\"sandbox_holds\":{held},\"renders_inside_sandbox\":{rendered},{}}}",
        results.join(",")
    );
    if held && rendered {
        0
    } else {
        1
    }
}
