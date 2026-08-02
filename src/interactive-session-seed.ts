import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import {
  preseedInteractiveSessionBindingCore,
  type InteractiveSessionBinding,
  type InteractiveSessionLocation,
  type InteractiveSessionSeedOptions,
} from "./interactive-session-binding.js";

/** Let the pinned Pi runtime author a new canonical transcript at one exact path. */
export function preseedInteractiveSessionBinding(
  location: InteractiveSessionLocation,
  options: InteractiveSessionSeedOptions = {},
): InteractiveSessionBinding {
  return preseedInteractiveSessionBindingCore(location, {
    ...options,
    openSession: options.openSession
      ?? ((path, directory, cwd) => PiSessionManager.open(path, directory, cwd)),
  });
}

/**
 * Exercise the pinned Pi open/context path for an already-verified transcript.
 * Current-version transcripts are read without migration or rewriting.
 */
export function assertInteractiveSessionBindingOpenable(
  binding: InteractiveSessionBinding,
): void {
  const session = PiSessionManager.open(
    binding.sessionFile,
    binding.sessionDirectory,
    binding.workspaceRealpath,
  );
  if (
    session.getSessionId() !== binding.sessionId
    || session.getSessionFile() !== binding.sessionFile
    || session.getCwd() !== binding.workspaceRealpath
  ) {
    throw new Error("Pi opened a different interactive session identity");
  }
  session.buildSessionContext();
}
