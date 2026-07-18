import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PiContextArtifacts } from "../pi-context-assembler.js";
import {
  createExpectedOpsWorkerParityContract,
  parseOpsWorkerParityAttestationReport,
  type OpsWorkerExpectedParityContract,
  type OpsWorkerParityAttestationReport,
} from "../pi-extensions/ops-worker-parity-attestation.js";
import {
  piResourceIdentity,
  type PiPrimaryResourceContract,
} from "../pi-primary-resources.js";

const MAX_REPORT_BYTES = 32 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface OpsWorkerParityLaunch {
  expected: OpsWorkerExpectedParityContract;
  expectedPath: string;
  reportPath: string;
  ackPath: string;
  parityExtensionPath: string;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSafeSessionFile(path: string): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Refusing unsafe parity handshake file");
    }
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  assertSafeSessionFile(path);
  const staging = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(staging, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(staging, path);
}

export function prepareOpsWorkerParityLaunch(input: {
  context: PiContextArtifacts;
  resources: PiPrimaryResourceContract;
  parityExtensionPath: string;
  sessionDirectory: string;
  opsPolicy: string;
}): OpsWorkerParityLaunch {
  const bundle = readFileSync(input.context.appendSystemPromptPath, "utf8");
  if (sha256(bundle) !== input.context.manifest.bundleHash) {
    throw new Error("Assembled Pi context bundle changed before parity preparation");
  }
  if (input.context.systemPromptPath) {
    const persona = readFileSync(input.context.systemPromptPath, "utf8");
    if (sha256(persona) !== input.context.manifest.personaHash) {
      throw new Error("Assembled Pi persona changed before parity preparation");
    }
  } else if (input.context.manifest.personaHash !== null) {
    throw new Error("Assembled Pi persona artifact is missing");
  }
  const expected = createExpectedOpsWorkerParityContract({
    primaryContextDigest: input.context.manifest.digest,
    customPromptHash: input.context.manifest.personaHash,
    appendSystemPromptHash: sha256(`${bundle}\n\n${input.opsPolicy}`),
    extensionIdentities: [
      ...input.resources.extensionIdentities,
      piResourceIdentity("extension", input.parityExtensionPath),
    ],
    skillIdentities: input.resources.skillIdentities,
    toolNames: input.resources.toolNames,
  });
  const expectedPath = join(input.sessionDirectory, "parity-expected-v1.json");
  const reportPath = join(input.sessionDirectory, "parity-report-v1.json");
  const ackPath = join(input.sessionDirectory, "parity-ack-v1.txt");
  writePrivateJson(expectedPath, expected);
  assertSafeSessionFile(reportPath);
  assertSafeSessionFile(ackPath);
  return {
    expected,
    expectedPath,
    reportPath,
    ackPath,
    parityExtensionPath: input.parityExtensionPath,
  };
}

export function tryReadOpsWorkerParityReport(
  launch: OpsWorkerParityLaunch,
): OpsWorkerParityAttestationReport | null {
  let stats;
  try {
    stats = lstatSync(launch.reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_REPORT_BYTES) {
    throw new Error("Ops-worker parity report is not a bounded regular file");
  }
  const descriptor = openSync(launch.reportPath, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== stats.ino || opened.dev !== stats.dev) {
      throw new Error("Ops-worker parity report changed during read");
    }
    const parsed = parseOpsWorkerParityAttestationReport(
      JSON.parse(readFileSync(descriptor, "utf8")),
    );
    if (
      parsed.expectedDigest !== launch.expected.digest
      || parsed.primaryContextDigest !== launch.expected.primaryContextDigest
    ) throw new Error("Ops-worker parity report does not match the prepared contract");
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}

export function acknowledgeOpsWorkerParityPass(launch: OpsWorkerParityLaunch): void {
  if (tryReadOpsWorkerParityReport(launch)?.status !== "PASS") {
    throw new Error("Cannot acknowledge a missing or failed Pi parity report");
  }
  const staging = `${launch.ackPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(staging, `${launch.expected.digest}\n`, { mode: 0o600, flag: "wx" });
  renameSync(staging, launch.ackPath);
}

export function formatOpsWorkerParityEvidence(
  report: OpsWorkerParityAttestationReport,
): string {
  return [
    `Pi parity v${report.version} ${report.status}`,
    `primary-context=${report.primaryContextDigest}`,
    `actual-context=${report.actualContextDigest}`,
    `capabilities=${report.actualCapabilityDigest}`,
    report.mismatch.length === 0 ? null : `mismatch=${report.mismatch.join(",")}`,
  ].filter((value): value is string => value !== null).join("; ");
}
