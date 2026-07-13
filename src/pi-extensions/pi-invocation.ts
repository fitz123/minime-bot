import {
  resolvePackageOwnedPiInvocation,
  type PiInvocation,
  type PiRuntimeResolveOptions,
} from "../pi-runtime.js";

export type { PiInvocation } from "../pi-runtime.js";

export interface PiInvocationOptions extends PiRuntimeResolveOptions {
  entrypoint?: string;
}

export function resolvePiInvocation(args: string[], options: PiInvocationOptions = {}): PiInvocation {
  const { command, args: invocationArgs } = resolvePackageOwnedPiInvocation("cli", args, {
    ...options,
    currentEntrypoint: options.entrypoint ?? options.currentEntrypoint,
  });
  return { command, args: invocationArgs };
}
