"""Test only. What systemd does for the PDF processor service (`Accept=yes`), without systemd.

    python3 pdf_socket_emulator.py <socket path> <processor path> <count file>

Listens on a Unix socket and starts the processor once per connection, with the connection as
its standard input and output and nothing else. The build-host suites use it to exercise the
API's socket path with the real processor in a container that has no service manager. It gives
none of the service's confinement; production uses the units written by ops/pdf_service.py.
"""
import os
import signal
import socket
import subprocess
import sys

path, processor, counter = sys.argv[1:4]
signal.signal(signal.SIGCHLD, signal.SIG_IGN)  # finished processors are not kept as zombies
try:
    os.unlink(path)
except FileNotFoundError:
    pass
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(path)
os.chmod(path, 0o600)
listener.listen(8)
accepted = 0
while True:
    connection, _ = listener.accept()
    subprocess.Popen([processor], stdin=connection, stdout=connection, stderr=subprocess.DEVNULL, env={}, cwd='/', close_fds=True)
    connection.close()
    accepted += 1
    with open(counter, 'w') as record:
        record.write(str(accepted))
