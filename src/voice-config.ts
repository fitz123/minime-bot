import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_WHISPER_MODEL_PATH = join(
  homedir(),
  ".minime/models/ggml-large-v3-turbo.bin",
);
