import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("foundation imports do not register process signal listeners", () => {
  const target = new URL("../behavioral-foundation.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'];
    const before = signals.map(signal => process.listenerCount(signal));
    await import(${JSON.stringify(target)});
    assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
  `], {encoding:"utf8"});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
