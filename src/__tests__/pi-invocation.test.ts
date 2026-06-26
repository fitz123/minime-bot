import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePiInvocation } from "../pi-extensions/pi-invocation.js";

describe("resolvePiInvocation", () => {
  it("reuses the current script when it exists", () => {
    assert.deepStrictEqual(
      resolvePiInvocation(["--mode", "json"], {
        execPath: "/usr/local/bin/node",
        entrypoint: "/opt/pi/dist/cli.js",
        exists: (path) => path === "/opt/pi/dist/cli.js",
      }),
      {
        command: "/usr/local/bin/node",
        args: ["/opt/pi/dist/cli.js", "--mode", "json"],
      },
    );
  });

  it("uses a non-generic runtime executable directly", () => {
    assert.deepStrictEqual(
      resolvePiInvocation(["--mode", "json"], {
        execPath: "/opt/bin/pi-custom",
        entrypoint: "",
      }),
      {
        command: "/opt/bin/pi-custom",
        args: ["--mode", "json"],
      },
    );
  });

  it("falls back to pi for generic runtimes without a real entrypoint", () => {
    assert.deepStrictEqual(
      resolvePiInvocation(["--mode", "json"], {
        execPath: "/usr/local/bin/node",
        entrypoint: "/$bunfs/root/virtual.js",
      }),
      {
        command: "pi",
        args: ["--mode", "json"],
      },
    );
  });
});
