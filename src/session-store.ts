import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SessionState } from "./types.js";
import { resolveWorkspaceContract } from "./workspace-contract.js";

function defaultStorePath(): string {
  return resolveWorkspaceContract().paths.sessionStorePath;
}

export type SessionStoreData = Record<string, SessionState>;

function isMissingErr(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwnedByCurrentUser(path: string, stat: Stats): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid.call(process)) {
    throw new Error(`Refusing to use ${path}: owned by uid ${stat.uid}`);
  }
}

function verifyPrivateStoreDir(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to use session store dir ${path}: it is a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to use session store dir ${path}: not a directory`);
  }
  assertOwnedByCurrentUser(path, stat);
  if ((stat.mode & 0o777) !== 0o700) {
    chmodSync(path, 0o700);
  }
}

function ensurePrivateStoreDir(path: string): void {
  try {
    verifyPrivateStoreDir(path);
    return;
  } catch (err) {
    if (!isMissingErr(err)) {
      throw err;
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  verifyPrivateStoreDir(path);
}

function removeExistingTempFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`Refusing to replace session store temp path ${path}: not a file`);
    }
    unlinkSync(path);
  } catch (err) {
    if (!isMissingErr(err)) {
      throw err;
    }
  }
}

export class SessionStore {
  private data: SessionStoreData = {};
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? defaultStorePath();
    this.load();
  }

  /** Load store from disk. Returns empty store if file doesn't exist. */
  load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        this.data = parsed as SessionStoreData;
      }
    } catch {
      this.data = {};
    }
  }

  /** Persist store to disk atomically (write .tmp then rename). */
  save(): void {
    const dir = dirname(this.path);
    ensurePrivateStoreDir(dir);
    const tmpPath = this.path + ".tmp";
    removeExistingTempFile(tmpPath);
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, this.path);
    chmodSync(this.path, 0o600);
  }

  getSession(chatId: string): SessionState | undefined {
    return this.data[chatId];
  }

  setSession(chatId: string, state: SessionState): void {
    this.data[chatId] = state;
    this.save();
  }

  deleteSession(chatId: string): void {
    delete this.data[chatId];
    this.save();
  }

  getAllSessions(): SessionStoreData {
    return { ...this.data };
  }

  /** For testing: return count of stored sessions */
  get size(): number {
    return Object.keys(this.data).length;
  }
}
