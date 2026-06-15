// Fix node-pty spawn-helper permissions (macOS npm/yarn tarball ships 644,
// which makes posix_spawnp fail with "posix_spawnp failed."). Run from
// postinstall so an interactive `claude` PTY can spawn. Mirrors the same
// fix in the mulmoterminal project.
import { chmodSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(__dirname, "../node_modules/node-pty/prebuilds");

for (const arch of ["darwin-arm64", "darwin-x64"]) {
  const helper = path.join(base, arch, "spawn-helper");
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    console.log(`Fixed permissions: ${helper}`);
  }
}
