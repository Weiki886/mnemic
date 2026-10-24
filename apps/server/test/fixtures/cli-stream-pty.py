"""Real terminal driver, stdlib only; offline HTTP fixture supplied by the parent test."""

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, tsx, config, entry, server, project = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
child = subprocess.Popen(
    [node, tsx, "--tsconfig", config, entry, "chat", "--server", server, "--project", project],
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
)
os.close(slave)
transcript = bytearray()
cursor = 0


def read_once(timeout):
    if select.select([master], [], [], timeout)[0]:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        transcript.extend(data)
        if len(transcript) > 1024 * 1024:
            raise RuntimeError("terminal output budget exceeded")


def wait_for(text, pattern=False):
    global cursor
    target = text.encode()
    deadline = time.monotonic() + 15
    while True:
        clean = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(transcript))
        match = re.search(target if pattern else re.escape(target), clean[cursor:])
        if match:
            cursor += match.end()
            return
        if child.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError("terminal did not reach " + text)
        read_once(min(0.2, max(0, deadline - time.monotonic())))


def question(text):
    os.write(master, text.encode())
    wait_for("> " + text)
    os.write(master, b"\r")


try:
    wait_for("会话 [0-9a-f-]{36}", pattern=True)
    question("PTY first user")
    wait_for("PTY partial 1")
    os.write(master, b"\x1b")
    wait_for("已中断 · 已保存")
    question("PTY second user")
    wait_for("PTY partial 2")
    os.write(master, b"\x03")
    wait_for("已中断 · 已保存")
    question("PTY continue user")
    wait_for("PTY completed")
    # Final citations exist only in the saved finish frame, not the live delta.
    wait_for("引用 ")
    os.write(master, b"\x03")
    deadline = time.monotonic() + 10
    while child.poll() is None and time.monotonic() < deadline:
        read_once(0.1)
    if child.poll() is None:
        raise RuntimeError("CLI did not exit after idle Ctrl+C")
    print(json.dumps({"exit_code": child.returncode, "transcript": transcript.decode(errors="replace")}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({"error": str(error), "transcript": transcript.decode(errors="replace")}, ensure_ascii=False))
    sys.exit(1)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
    os.close(master)
