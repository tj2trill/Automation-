// Copy the dashboard's static files next to the compiled server (tsc only emits .js).
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "host", "dashboard"), join(root, "dist", "host", "dashboard"), { recursive: true });
console.log("copied dashboard assets to dist/host/dashboard");
