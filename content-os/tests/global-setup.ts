import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Resets the local test database (shim + migrations) once per run, but only
 * when DB suites are part of the run. Set SKIP_DB_RESET=1 to reuse an
 * externally provisioned TEST_DATABASE_URL.
 */
export default function setup() {
  const args = process.argv.join(" ");
  const unitOnly = /tests[\\/]+unit/.test(args) && !/tests[\\/]+db/.test(args);
  if (unitOnly || process.env.SKIP_DB_RESET === "1") return;
  execFileSync("bash", [fileURLToPath(new URL("../scripts/local-db.sh", import.meta.url))], { stdio: "inherit" });
}
