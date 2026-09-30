"""Offline real Pi TUI smoke in an ordinary PTY.
Pass --socket PATH for the connected round trip driven by the integration test.
Run from package root: python3 src/__tests__/fixtures/collaboration-pty-smoke.py
"""
import argparse
import fcntl
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument("--socket")
args = parser.parse_args()
repo = Path.cwd()
(repo / ".tmp/222").mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="collab-pty-") as temp:
    root = Path(temp)
    env = os.environ.copy()
    env.update({"PI_CODING_AGENT_DIR": str(root / "agent"),
                "PI_CODING_AGENT_SESSION_DIR": str(root / "sessions"),
                "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
                "MINIME_COLLABORATION_SOCKET": (args.socket or str(root / "absent.sock")), "TERM": "xterm-256color"})
    env.pop("MINIME_COLLABORATION_SESSION", None)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
    command = [shutil.which("node"), str(repo / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
               "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
               "--extension", str(repo / "src/__tests__/fixtures/collaboration-provider.ts"),
               "--extension", str(repo / "extensions/pi/collaboration.ts"), "--model", "openai-codex/fixture"]
    child = subprocess.Popen(command, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    output = b""
    start = time.monotonic()
    submitted = False
    expected = b"COLLABORATION_COMPLETE" if args.socket else b"Internal tool receipt recorded"
    try:
        while time.monotonic() - start < 20:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                output += data
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")
            if not submitted and time.monotonic() - start > 2:
                os.write(master, b"START_COLLAB\r")
                submitted = True
            if expected in output:
                break
        name = "pty-connected-output.log" if args.socket else "pty-output.log"
        (repo / ".tmp/222" / name).write_bytes(output)
        assert expected in output, f"TUI did not finish; see .tmp/222/{name}"
        if args.socket:
            print("PASS: COLLABORATION_COMPLETE in real Pi TUI/PTY through the bot router")
        else:
            assert b"disconnected" in output, "Expected absent-router receipt in TUI"
            print("PASS: real Pi TUI/PTY executed send, displayed disconnected receipt, and finished")
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(master)
