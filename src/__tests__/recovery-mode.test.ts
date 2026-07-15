import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertRecoveryToolCallAllowed,
  assertRequiredRecoveryExtensionLoaded,
  recoveryEndpointAllowed,
  recoveryModeAllowsDispatch,
  recoveryModeAllowsMutation,
  resolveRequiredRecoveryExtensionArgs,
} from "../pi-extensions/recovery-mode.js";

describe("recovery mode boundaries", () => {
  it("uses the exact dispatch and mutation matrix", () => {
    assert.equal(recoveryModeAllowsDispatch("observe"), false);
    assert.equal(recoveryModeAllowsDispatch("diagnose"), true);
    assert.equal(recoveryModeAllowsDispatch("enabled"), true);
    assert.equal(recoveryModeAllowsMutation("observe"), false);
    assert.equal(recoveryModeAllowsMutation("diagnose"), false);
    assert.equal(recoveryModeAllowsMutation("enabled"), true);

    for (const operation of ["inspect", "reconcile", "blocked", "finish"] as const) {
      assert.equal(recoveryEndpointAllowed("observe", operation), false);
      assert.equal(recoveryEndpointAllowed("diagnose", operation), true);
      assert.equal(recoveryEndpointAllowed("enabled", operation), true);
    }
    assert.equal(recoveryEndpointAllowed("diagnose", "mutate"), false);
    assert.equal(recoveryEndpointAllowed("enabled", "mutate"), true);
    assert.throws(() => assertRecoveryToolCallAllowed("diagnose", true), /diagnose/);
    assert.doesNotThrow(() => assertRecoveryToolCallAllowed("diagnose", false));
    assert.doesNotThrow(() => assertRecoveryToolCallAllowed("enabled", true));
  });

  it("fails fixer spawning closed when its extension is disabled, missing, or omitted", () => {
    const wrapper = "/private/recovery-extension.js";
    const exists = (path: string) => path === wrapper;
    assert.throws(
      () => resolveRequiredRecoveryExtensionArgs("observe", wrapper, { exists }),
      /observe/,
    );
    assert.throws(
      () =>
        resolveRequiredRecoveryExtensionArgs("diagnose", wrapper, {
          env: { PI_EXTENSIONS_DISABLED: "1" },
          exists,
        }),
      /PI_EXTENSIONS_DISABLED=1/,
    );
    assert.throws(
      () => resolveRequiredRecoveryExtensionArgs("enabled", wrapper, { exists: () => false }),
      /not found/,
    );
    assert.deepEqual(
      resolveRequiredRecoveryExtensionArgs("diagnose", wrapper, { env: {}, exists }),
      ["--extension", wrapper],
    );
    assert.throws(
      () => assertRequiredRecoveryExtensionLoaded("enabled", wrapper, ["--no-extensions"], { exists }),
      /missing/,
    );
    assert.doesNotThrow(() =>
      assertRequiredRecoveryExtensionLoaded(
        "enabled",
        wrapper,
        ["--no-extensions", "--extension", wrapper],
        { exists },
      ),
    );
  });
});
