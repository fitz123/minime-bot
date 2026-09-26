import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeReadinessMarker,
  resolveRuntimeReadinessPath,
} from "../runtime-readiness.js";

describe("runtime readiness marker", () => {
  it("isolates the default by control workspace and honors an explicit override", () => {
    assert.equal(
      resolveRuntimeReadinessPath({ HOME: "/example/home" }),
      join("/example/home", "Library", "Logs", "minime-bot", "restart", "bot-ready"),
    );
    assert.equal(
      resolveRuntimeReadinessPath({
        HOME: "/example/home",
        MINIME_CONTROL_WORKSPACE_ROOT: "/control/primary",
      }),
      join("/control/primary", ".tmp", "bot-ready"),
    );
    assert.equal(
      resolveRuntimeReadinessPath({
        HOME: "/ignored",
        MINIME_CONTROL_WORKSPACE_ROOT: "/control/ignored",
        RESTART_READY_PATH: "/runtime/custom-ready",
      }),
      "/runtime/custom-ready",
    );
  });

  it("atomically publishes its PID and removes its own marker on exit", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-readiness-test-"));
    try {
      const path = join(root, "nested", "bot-ready");
      const marker = createRuntimeReadinessMarker({ path, pid: 12345, nonce: () => "fixed" });
      const target = new EventEmitter() as unknown as NodeJS.Process;
      marker.installProcessExitHook(target);

      assert.equal(existsSync(path), false);
      marker.publish();
      assert.equal(readFileSync(path, "utf8"), "12345\n");
      assert.deepEqual(readdirSync(join(root, "nested")), ["bot-ready"]);

      target.emit("exit", 0);
      assert.equal(existsSync(path), false);
      assert.equal(marker.clear(), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not clear a marker replaced by another process", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-readiness-owner-test-"));
    try {
      const path = join(root, "bot-ready");
      const marker = createRuntimeReadinessMarker({ path, pid: 1111, nonce: () => "owner" });
      marker.publish();
      writeFileSync(path, "2222\n");

      assert.equal(marker.clear(), false);
      assert.equal(readFileSync(path, "utf8"), "2222\n");

      const neverPublished = createRuntimeReadinessMarker({ path, pid: 2222 });
      assert.equal(neverPublished.clear(), false);
      assert.equal(readFileSync(path, "utf8"), "2222\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
