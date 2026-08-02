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
