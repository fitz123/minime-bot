import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  acquireRuntimeGuard,
  preflightMediaRoot,
  recordStartupConflict,
  resolveRuntimeIdentity,
  runtimeGuardResources,
  runtimeResourceLockPath,
  StartupConflictError,
  type RuntimeGuard,
  type RuntimeResource,
} from "../runtime-guard.js";
import {
  initializeInstanceIdentity,
  startMetricsServer,
  stopMetricsServer,
} from "../metrics.js";

const tempRoots: string[] = [];
const guards: RuntimeGuard[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "minime-runtime-guard-test-"));
  tempRoots.push(root);
  return root;
}

const quiet = {
  recordMetric: () => {},
  writeLog: () => {},
};

function acquire(
  lockRoot: string,
  resources: RuntimeResource[],
  overrides: Partial<Parameters<typeof acquireRuntimeGuard>[0]> = {},
): RuntimeGuard {
  const guard = acquireRuntimeGuard({
    lockRoot,
    resources,
    processStartToken: () => "aaaaaaaaaaaaaaaa",
    ...quiet,
    ...overrides,
  });
  guards.push(guard);
  return guard;
}

afterEach(async () => {
  await stopMetricsServer();
  for (const guard of guards.splice(0).reverse()) guard.release();
  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe("runtime identity", () => {
  it("uses an explicit non-empty slot and injectable identity values", () => {
    assert.deepEqual(resolveRuntimeIdentity({
      env: { MINIME_BOT_SLOT: "  canary  " },
      cwd: () => "/ignored/source-slot",
      realpath: (path) => path,
      homedir: () => "/srv/example-home",
      userInfo: () => ({ username: "example-user" }),
      pid: 1234,
    }), {
      user: "example-user",
      home: "/srv/example-home",
      slot: "canary",
      pid: "1234",
    });
  });

  it("falls back to the basename of the real working directory", () => {
    const identity = resolveRuntimeIdentity({
      env: { MINIME_BOT_SLOT: "  " },
      cwd: () => "/release/current",
      realpath: () => "/release/slots/green",
      homedir: () => "/home/example",
      userInfo: () => ({ username: "example" }),
      pid: 5678,
    });
    assert.equal(identity.slot, "green");
  });
});

describe("startup conflict diagnostics", () => {
  it("emits only the stable bounded marker and reason", () => {
    const secret = "synthetic-token-value";
    const resource = "/private/synthetic-media-root";
    const messages: string[] = [];
    const reasons: string[] = [];

    recordStartupConflict("instance_lock_held", {
      writeLog: (message) => messages.push(message),
      recordMetric: (reason) => reasons.push(reason),
    });

    assert.deepEqual(messages, ["MINIME_STARTUP_GUARD_CONFLICT reason=instance_lock_held"]);
    assert.deepEqual(reasons, ["instance_lock_held"]);
    assert.doesNotMatch(messages.join("\n"), new RegExp(`${secret}|${resource}`));
  });
});

describe("runtime resource ownership", () => {
  const shared: RuntimeResource = { kind: "media", value: "/synthetic/shared-media" };

  it("rejects an active complete owner without disturbing its claim", () => {
    const root = tempRoot();
    const owner = acquire(root, [shared], { pid: process.pid });
    const claimEntries = readdirSync(owner.lockPaths[0]);

    assert.throws(
      () => acquire(root, [shared], { pid: process.pid, isProcessAlive: () => true }),
      (error: unknown) => error instanceof StartupConflictError && error.reason === "instance_lock_held",
    );
    assert.deepEqual(readdirSync(owner.lockPaths[0]), claimEntries);
  });

  it("recovers a complete claim whose process is dead", () => {
    const root = tempRoot();
    const old = acquire(root, [shared], { pid: 24680 });
    const oldInodeEntry = readdirSync(old.lockPaths[0])[0];

    const replacement = acquire(root, [shared], {
      pid: process.pid,
      processStartToken: (pid) => pid === 24680 ? undefined : "bbbbbbbbbbbbbbbb",
      isProcessAlive: () => false,
    });

    assert.notEqual(readdirSync(replacement.lockPaths[0])[0], oldInodeEntry);
    assert.equal(old.release(), false);
  });

  it("recovers a complete claim after PID reuse without trusting kill(pid, 0)", () => {
    const root = tempRoot();
    const old = acquire(root, [shared], { pid: 13579 });
    const replacement = acquire(root, [shared], {
      processStartToken: (pid) => pid === 13579 ? "bbbbbbbbbbbbbbbb" : "cccccccccccccccc",
      isProcessAlive: () => true,
    });

    assert.ok(existsSync(replacement.lockPaths[0]));
    assert.equal(old.release(), false);
  });

  it("recovers an old empty directory left by a crash after mkdir", () => {
    const root = tempRoot();
    const lockPath = runtimeResourceLockPath(shared, root);
    mkdirSync(lockPath, { mode: 0o700 });
    utimesSync(lockPath, new Date(0), new Date(0));

    const replacement = acquire(root, [shared], { now: () => 10_000, incompleteGraceMs: 100 });
    assert.equal(readdirSync(replacement.lockPaths[0]).length, 2);
  });

  it("fails closed for a recent empty directory", () => {
    const root = tempRoot();
    const lockPath = runtimeResourceLockPath(shared, root);
    mkdirSync(lockPath, { mode: 0o700 });
    utimesSync(lockPath, new Date(9_950), new Date(9_950));

    assert.throws(
      () => acquire(root, [shared], { now: () => 10_000, incompleteGraceMs: 100 }),
      StartupConflictError,
    );
    assert.deepEqual(readdirSync(lockPath), []);
  });

  it("recovers an old exact claim-only publication", () => {
    const root = tempRoot();
    const lockPath = runtimeResourceLockPath(shared, root);
    const suffix = "999-deadbeefdeadbeef-acde-1234";
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, `claim-${suffix}`), `${suffix}\n`, { mode: 0o600 });
    utimesSync(lockPath, new Date(0), new Date(0));

    const replacement = acquire(root, [shared], { now: () => 10_000, incompleteGraceMs: 100 });
    assert.equal(readdirSync(replacement.lockPaths[0]).length, 2);
  });

  it("refuses foreign, malformed, replaced, and raced lock states", () => {
    const foreignRoot = tempRoot();
    assert.throws(
      () => acquire(foreignRoot, [shared], {
        expectedUid: (typeof process.getuid === "function" ? process.getuid() : 0) + 1,
      }),
      StartupConflictError,
    );

    const malformedRoot = tempRoot();
    const malformedPath = runtimeResourceLockPath(shared, malformedRoot);
    mkdirSync(malformedPath, { mode: 0o700 });
    writeFileSync(join(malformedPath, "claim-malformed"), "malformed\n");
    writeFileSync(join(malformedPath, "owner-malformed"), "malformed\n");
    assert.throws(() => acquire(malformedRoot, [shared]), StartupConflictError);

    const replacedRoot = tempRoot();
    const replacedPath = runtimeResourceLockPath(shared, replacedRoot);
    mkdirSync(replacedPath, { mode: 0o700 });
    utimesSync(replacedPath, new Date(0), new Date(0));
    assert.throws(() => acquire(replacedRoot, [shared], {
      now: () => 10_000,
      incompleteGraceMs: 100,
      beforeRecoveryVerification: (path) => {
        rmSync(path, { recursive: true });
        mkdirSync(path, { mode: 0o700 });
        utimesSync(path, new Date(0), new Date(0));
      },
    }), StartupConflictError);
    assert.ok(existsSync(replacedPath));

    const racedRoot = tempRoot();
    const racedPath = runtimeResourceLockPath(shared, racedRoot);
    mkdirSync(racedPath, { mode: 0o700 });
    utimesSync(racedPath, new Date(0), new Date(0));
    assert.throws(() => acquire(racedRoot, [shared], {
      now: () => 10_000,
      incompleteGraceMs: 100,
      beforeRecoveryVerification: (path) => writeFileSync(join(path, "raced"), "raced"),
    }), StartupConflictError);
    assert.deepEqual(readdirSync(racedPath), ["raced"]);
  });

  it("rolls back earlier claims when a later deterministic acquisition fails", () => {
    const root = tempRoot();
    const resources: RuntimeResource[] = [
      { kind: "media", value: "/synthetic/resource-a" },
      { kind: "telegram", value: "synthetic-fingerprint-b" },
    ];
    const ordered = [...resources].sort((left, right) =>
      runtimeResourceLockPath(left, root).localeCompare(runtimeResourceLockPath(right, root))
    );
    const owner = acquire(root, [ordered[1]]);

    assert.throws(() => acquire(root, resources), StartupConflictError);
    assert.deepEqual(readdirSync(root), [basename(owner.lockPaths[0])]);
  });

  it("releases idempotently only while inode, nonce, and exact entries still match", () => {
    const root = tempRoot();
    const normal = acquire(root, [shared]);
    const normalPath = normal.lockPaths[0];
    assert.equal(normal.release(), true);
    assert.equal(normal.release(), true);
    assert.equal(existsSync(normalPath), false);

    const changed = acquire(root, [shared]);
    writeFileSync(join(changed.lockPaths[0], "unexpected-entry"), "do not remove");
    assert.equal(changed.release(), false);
    assert.equal(changed.release(), false);
    assert.ok(existsSync(changed.lockPaths[0]));
  });

  it("refuses release when the lock directory is replaced", () => {
    const root = tempRoot();
    const guard = acquire(root, [shared], {
      beforeReleaseVerification: (path) => {
        rmSync(path, { recursive: true });
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "replacement"), "keep");
      },
    });
    assert.equal(guard.release(), false);
    assert.equal(readFileSync(join(guard.lockPaths[0], "replacement"), "utf8"), "keep");
  });
});

describe("media-root preflight", () => {
  it("allows missing and owned directory roots without mutation", () => {
    const base = tempRoot();
    const missing = join(base, "missing");
    assert.equal(preflightMediaRoot(missing, quiet), missing);
    assert.equal(existsSync(missing), false);

    const safe = join(base, "safe");
    mkdirSync(safe, { mode: 0o700 });
    assert.equal(preflightMediaRoot(safe, quiet), realpathSync(safe));
  });

  it("classifies foreign and symlink roots with bounded reasons", () => {
    const base = tempRoot();
    const safe = join(base, "safe");
    mkdirSync(safe, { mode: 0o700 });
    assert.throws(
      () => preflightMediaRoot(safe, {
        ...quiet,
        expectedUid: (typeof process.getuid === "function" ? process.getuid() : 0) + 1,
      }),
      (error: unknown) => error instanceof StartupConflictError && error.reason === "foreign_media_owner",
    );

    const link = join(base, "link");
    symlinkSync(safe, link);
    assert.throws(
      () => preflightMediaRoot(link, quiet),
      (error: unknown) => error instanceof StartupConflictError && error.reason === "unsafe_media_root",
    );
  });
});

describe("bounded lifecycle integration", () => {
  it("cleans startup claims and exits nonzero when the configured metrics port is occupied", async () => {
    const workspace = tempRoot();
    mkdirSync(join(workspace, "agent"), { mode: 0o700 });
    const occupied = createServer();
    await new Promise<void>((resolveListen) => occupied.listen(0, "127.0.0.1", resolveListen));
    const address = occupied.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(join(workspace, "config.yaml"), [
      "agents:",
      "  main:",
      "    workspaceCwd: ./agent",
      "    model: gpt-5.5",
      "telegramTokenEnv: SYNTHETIC_MAIN_TOKEN",
      "bindings:",
      "  - chatId: 111",
      "    agentId: main",
      "    kind: dm",
      `metricsPort: ${address.port}`,
      "",
    ].join("\n"));

    const defaultLockRoot = dirname(runtimeResourceLockPath({ kind: "media", value: "probe" }));
    const entriesBefore = existsSync(defaultLockRoot) ? readdirSync(defaultLockRoot).sort() : [];
    const token = "synthetic-main-token-do-not-log";
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        LOG_LEVEL: "error",
        MINIME_CONTROL_WORKSPACE_ROOT: workspace,
        MINIME_AGENT_WORKSPACE_ROOT: workspace,
        MINIME_TEST_MEDIA_BASE: join(workspace, "media-base"),
        SYNTHETIC_MAIN_TOKEN: token,
      },
    });
    await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));

    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /MINIME_STARTUP_GUARD_CONFLICT reason=metrics_port_in_use/);
    assert.doesNotMatch(child.stderr, new RegExp(`${token}|${workspace}`));
    const entriesAfter = existsSync(defaultLockRoot) ? readdirSync(defaultLockRoot).sort() : [];
    assert.deepEqual(entriesAfter, entriesBefore);
  });

  it("keeps the serving owner intact through overlap and exposes replacement identity after teardown", async () => {
    const root = tempRoot();
    const candidates: RuntimeResource[] = runtimeGuardResources(
      "/synthetic/lifecycle-media",
      "synthetic-lifecycle-token",
    );
    const ordered = [...candidates].sort((left, right) =>
      runtimeResourceLockPath(left, root).localeCompare(runtimeResourceLockPath(right, root))
    );
    const servingOwner = acquire(root, [ordered[1]], { processStartToken: undefined });
    initializeInstanceIdentity({ user: "owner", home: "/owner", slot: "old", pid: String(process.pid) });
    const oldMetrics = await startMetricsServer(0);
    const address = oldMetrics.address();
    assert.ok(address && typeof address === "object");

    const moduleUrl = pathToFileURL(resolve("src/runtime-guard.ts")).href;
    const contenderSource = [
      `import { acquireRuntimeGuard } from ${JSON.stringify(moduleUrl)};`,
      `const resources = ${JSON.stringify(ordered)};`,
      `try { acquireRuntimeGuard({ lockRoot: ${JSON.stringify(root)}, resources }); process.exit(0); }`,
      `catch { process.exit(23); }`,
    ].join("\n");
    const contender = spawnSync(process.execPath, [
      "--import", "tsx",
      "--input-type=module",
      "--eval", contenderSource,
    ], { encoding: "utf8", timeout: 10_000 });

    assert.equal(contender.status, 23);
    assert.match(contender.stderr, /MINIME_STARTUP_GUARD_CONFLICT reason=instance_lock_held/);
    assert.deepEqual(readdirSync(root), [basename(servingOwner.lockPaths[0])]);
    assert.equal(oldMetrics.listening, true);

    const teardown: string[] = [];
    teardown.push("polling");
    assert.ok(existsSync(servingOwner.lockPaths[0]));
    teardown.push("sessions");
    assert.ok(existsSync(servingOwner.lockPaths[0]));
    teardown.push("media");
    await stopMetricsServer();
    teardown.push("metrics");
    assert.ok(existsSync(servingOwner.lockPaths[0]));
    assert.equal(servingOwner.release(), true);
    teardown.push("claims");
    assert.deepEqual(teardown, ["polling", "sessions", "media", "metrics", "claims"]);

    const replacement = acquire(root, [ordered[1]], {
      processStartToken: () => "bbbbbbbbbbbbbbbb",
    });
    initializeInstanceIdentity({ user: "owner", home: "/owner", slot: "new", pid: "9876" });
    await startMetricsServer(address.port);
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    const body = await response.text();
    assert.match(body, /minime_bot_instance_info\{user="owner",home="\/owner",slot="new",pid="9876"\} 1/);
    assert.ok(existsSync(replacement.lockPaths[0]));
  });
});
