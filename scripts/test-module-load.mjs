import assert from "node:assert/strict";

// Node's `--check` silently accepts ESM syntax in `.js` files on some
// versions, so actually evaluate the browser modules that app.js imports.
const modules = [
  "../ui/js/core/direction.js",
  "../ui/js/core/drivers.js",
  "../ui/js/views/dpad.js",
];
for (const path of modules) {
  const mod = await import(path);
  assert.ok(mod && typeof mod === "object", `module did not load: ${path}`);
}
console.log("browser module load tests: PASS");
