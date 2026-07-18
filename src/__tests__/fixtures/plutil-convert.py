#!/usr/bin/env python3

import json
import plistlib
import sys


args = sys.argv[1:]
input_path = args[4] if len(args) >= 5 else None

try:
    if (
        len(args) != 5
        or args[0] != "-convert"
        or args[1] not in {"json", "xml1"}
        or args[2] != "-o"
        or args[3] != "-"
        or not input_path
    ):
        raise ValueError("unsupported arguments")

    if input_path == "-":
        content = sys.stdin.buffer.read()
    else:
        with open(input_path, "rb") as input_file:
            content = input_file.read()
    value = plistlib.loads(content)

    if args[1] == "json":
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    else:
        sys.stdout.buffer.write(
            plistlib.dumps(value, fmt=plistlib.FMT_XML, sort_keys=False)
        )
except Exception:
    sys.stderr.write(
        f"fixture plist parser rejected private-parser-marker at {input_path or 'unknown'}\n"
    )
    sys.exit(1)
