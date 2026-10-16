import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [
  spawn(
    "uv",
    ["run", "--extra", "train", "--extra", "disease-data", "--extra", "language", "python", "-m", "services.api.wording_autoimport", "--directory",
      process.env.VISCERA_WORDING_DOWNLOADS ?? path.join(os.homedir(), "Downloads")],
    { cwd: root, stdio: "inherit" },
  ),
  spawn(
    "uv",
    [
      "run", "--extra", "train", "--extra", "disease-data", "--extra", "language",
      "uvicorn", "services.api.app:app", "--host", "127.0.0.1", "--port", "8000",
    ],
    { cwd: root, stdio: "inherit" },
  ),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "apps/studio/vite.config.ts", "--host", "127.0.0.1"],
    { cwd: root, stdio: "inherit" },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
