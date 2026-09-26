import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const RUNTIME_READINESS_PATH_ENV = "RESTART_READY_PATH";

export function resolveRuntimeReadinessPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env[RUNTIME_READINESS_PATH_ENV]) return env[RUNTIME_READINESS_PATH_ENV];
  if (env.MINIME_CONTROL_WORKSPACE_ROOT) {
    return join(env.MINIME_CONTROL_WORKSPACE_ROOT, ".tmp", "bot-ready");
  }
  return join(env.HOME || homedir(), "Library", "Logs", "minime-bot", "restart", "bot-ready");
}

export interface RuntimeReadinessMarkerOptions {
  path?: string;
  pid?: number;
  nonce?: () => string;
}

export interface RuntimeReadinessMarker {
  readonly path: string;
  readonly pid: number;
  publish(): void;
  clear(): boolean;
  installProcessExitHook(target?: NodeJS.Process): () => void;
}

/** Publish and clear the serving-ready PID without allowing an older process to remove a replacement's marker. */
export function createRuntimeReadinessMarker(
  options: RuntimeReadinessMarkerOptions = {},
): RuntimeReadinessMarker {
  const path = options.path ?? resolveRuntimeReadinessPath();
  const pid = options.pid ?? process.pid;
  let ownsPublication = false;
  let publicationSequence = 0;

  const publish = (): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const suffix = options.nonce?.() ?? `${Date.now()}-${publicationSequence++}`;
    const temporaryPath = `${path}.tmp.${pid}.${suffix}`;
    try {
      writeFileSync(temporaryPath, `${pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, path);
      ownsPublication = true;
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };

  const clear = (): boolean => {
    if (!ownsPublication) return true;

    let owner: string;
    try {
      owner = readFileSync(path, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        ownsPublication = false;
        return false;
      }
      throw error;
    }
    if (owner !== String(pid)) {
      ownsPublication = false;
      return false;
    }

    try {
      unlinkSync(path);
      ownsPublication = false;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        ownsPublication = false;
        return false;
      }
      throw error;
    }
  };

  return {
    path,
    pid,
    publish,
    clear,
    installProcessExitHook(target = process): () => void {
      const onExit = () => {
        try {
          clear();
        } catch {
          // Process exit cannot recover from marker cleanup failure. A stale PID
          // remains safe because restart verification also checks launchd's PID.
        }
      };
      target.once("exit", onExit);
      return () => target.off("exit", onExit);
    },
  };
}
