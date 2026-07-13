import {
  resolvePackageOwnedPiInvocation,
  type PiInvocation,
  type PiRuntimeResolveOptions,
} from "../pi-runtime.js";

export type { PiInvocation } from "../pi-runtime.js";

export interface PiInvocationOptions extends Omit<PiRuntimeResolveOptions, "currentEntrypoint"> {
  entrypoint?: string;
}

export function resolvePiInvocation(args: string[], options: PiInvocationOptions = {}): PiInvocation {
  const { entrypoint, ...resolveOptions } = options;
  const { command, args: invocationArgs } = resolvePackageOwnedPiInvocation("cli", args, {
    ...resolveOptions,
    currentEntrypoint: entrypoint,
  });
  return { command, args: invocationArgs };
}
