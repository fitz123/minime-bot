import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface PiInvocationOptions {
  execPath?: string;
  entrypoint?: string;
  exists?: (path: string) => boolean;
}

export function resolvePiInvocation(args: string[], options: PiInvocationOptions = {}): PiInvocation {
  const execPath = options.execPath ?? process.execPath;
  const entrypoint = options.entrypoint ?? process.argv[1];
  const fileExists = options.exists ?? existsSync;
  const isBunVirtualScript = entrypoint?.startsWith("/$bunfs/root/");

  if (entrypoint && !isBunVirtualScript && fileExists(entrypoint)) {
    return { command: execPath, args: [entrypoint, ...args] };
  }

  const execName = basename(execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: execPath, args };
  }

  return { command: "pi", args };
}
