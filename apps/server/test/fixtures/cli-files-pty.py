"""Drive the actual CLI over a PTY; project files/server are isolated test fixtures."""
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

node, tsx, config, entry, server, project, root = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
child = subprocess.Popen(
    [node, tsx, "--tsconfig", config, entry, "chat", "--server", server,
     "--project", project, "--root", root],
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
)
os.close(slave)
transcript = bytearray()
cursor = 0


def read_once(timeout):
    if select.select([master], [], [], timeout)[0]:
        try:
            transcript.extend(os.read(master, 65536))
        except OSError as error:
            if error.errno != errno.EIO:
                raise
        if len(transcript) > 2 * 1024 * 1024:
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


try:
    wait_for("会话 [0-9a-f-]{36}", True)
    os.write(master, b"@missing")
    wait_for("> @missing")
    os.write(master, b"\r")
    wait_for("未发送")
    wait_for("> @missing")
    for remaining in range(len("@missing") - 1, -1, -1):
        os.write(master, b"\x7f")
        wait_for("> " + "@missing"[:remaining])
    os.write(master, b"inspect @src/entry")
    wait_for("> inspect @src/entry")
    os.write(master, b"\t")
    wait_for('@"src/entry file.ts"')
    os.write(master, b" @README.md @docs/")
    wait_for("@README.md @docs/")
    os.write(master, b"\r")
    wait_for("已截断")
    wait_for("未召回跨会话记忆；已提供项目文件上下文。")
    wait_for("PTY FILE ANSWER")
    os.write(master, b"/exit")
    wait_for("> /exit")
    os.write(master, b"\r")
    deadline = time.monotonic() + 10
    while child.poll() is None and time.monotonic() < deadline:
        read_once(0.1)
    if child.poll() is None:
        raise RuntimeError("CLI did not commit and exit")
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
