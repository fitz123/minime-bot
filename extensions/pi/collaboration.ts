import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCollaboration } from "../../src/pi-extensions/collaboration.js";
export default function (pi: ExtensionAPI): void { registerCollaboration(pi); }
