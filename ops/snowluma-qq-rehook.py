#!/usr/bin/env python3
"""Reattach SnowLuma after supervisor starts a replacement QQ process.

Supervisor event listener; stdout is reserved for its acknowledgement protocol.
No QQ messages are read or sent. An obsolete PID never restarts the bridge.
"""
import subprocess
import sys
import threading


def fields(line):
    return dict(item.split(":", 1) for item in line.split() if ":" in item)


def reattach(pid):
    try:
        current = subprocess.check_output(
            ["supervisorctl", "pid", "qq"], text=True, timeout=10
        ).strip()
        if current != pid:
            return
        result = subprocess.run(
            ["supervisorctl", "restart", "snowluma"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45,
        )
        print("QQ replacement: bridge reattach exit=" + str(result.returncode), file=sys.stderr, flush=True)
    except (OSError, subprocess.SubprocessError):
        print("QQ replacement: bridge reattach failed", file=sys.stderr, flush=True)


def main():
    pending = None
    while True:
        sys.stdout.write("READY\n")
        sys.stdout.flush()
        line = sys.stdin.readline()
        if not line:
            return
        header = fields(line)
        body = fields(sys.stdin.read(int(header["len"])))
        if header.get("eventname") == "PROCESS_STATE_RUNNING" and body.get("processname") == "qq":
            if pending:
                pending.cancel()
            pending = threading.Timer(20, reattach, args=(body.get("pid", ""),))
            pending.daemon = True
            pending.start()
        sys.stdout.write("RESULT 2\nOK")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
