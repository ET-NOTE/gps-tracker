/* Loaded by the dynamic linker AFTER exec and BEFORE an application reads keys.
 * Unlike a pre-exec wrapper, exec cannot reset this process's dumpability.
 * Use only in reviewed GPS units; no host-wide core_pattern change.
 */
#define _GNU_SOURCE
#include <sys/prctl.h>
#include <unistd.h>

__attribute__((constructor)) static void gps_no_core(void) {
    if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 ||
        prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) {
        static const char message[] = "GPS memory protection unavailable; refusing startup\n";
        ssize_t written = write(STDERR_FILENO, message, sizeof(message) - 1);
        (void)written;
        _exit(78);
    }
}
