import { assertEquals, assertThrows } from "@std/assert";
import {
  isEmptyPermissions,
  parsePermissions,
  PERMISSION_CATALOG,
  PermissionError,
} from "./permissions.ts";

Deno.test("PERMISSION_CATALOG lists metadata as read-only", () => {
  assertEquals(PERMISSION_CATALOG.metadata, ["read"]);
});

Deno.test("parsePermissions keeps valid entries", () => {
  assertEquals(
    parsePermissions({ contents: "read", issues: "write" }),
    { contents: "read", issues: "write" },
  );
});

Deno.test("parsePermissions drops entries set to none or blank", () => {
  assertEquals(
    parsePermissions({ contents: "read", issues: "none", pull_requests: "" }),
    { contents: "read" },
  );
});

Deno.test("parsePermissions rejects an unknown permission", () => {
  assertThrows(
    () => parsePermissions({ wizardry: "read" }),
    PermissionError,
    "unknown permission",
  );
});

Deno.test("parsePermissions rejects a level the permission does not allow", () => {
  // metadata only allows read
  assertThrows(
    () => parsePermissions({ metadata: "write" }),
    PermissionError,
    "does not allow",
  );
});

Deno.test("parsePermissions rejects a nonsense level", () => {
  assertThrows(
    () => parsePermissions({ contents: "sudo" }),
    PermissionError,
    "does not allow",
  );
});

Deno.test("parsePermissions returns empty object when everything is none", () => {
  const perms = parsePermissions({ contents: "none" });
  assertEquals(perms, {});
  assertEquals(isEmptyPermissions(perms), true);
});

Deno.test("isEmptyPermissions is false when at least one grant exists", () => {
  assertEquals(isEmptyPermissions({ contents: "read" }), false);
});
