import { writeFile } from "fs/promises";
await writeFile("dist/cli.js", `#!/usr/bin/env node
// Force CLI mode by inserting 'cli' after the binary in argv
try {
  const old = process.argv.slice();
  old.splice(2, 0, "cli");
  process.argv = old;
  await import("./index.js");
} catch (e) {
  console.error(e);
  process.exit(1);
}
`);