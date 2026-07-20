import { assertEquals, assertThrows } from "@std/assert";
import { PathsError, resolvePaths } from "./paths.ts";

Deno.test("resolvePaths defaults to ~/.config/claw and ~/.cache/claw under HOME", () => {
  const paths = resolvePaths({ HOME: "/home/dtinth" });
  assertEquals(paths.configDir, "/home/dtinth/.config/claw");
  assertEquals(paths.cacheDir, "/home/dtinth/.cache/claw");
});

Deno.test("resolvePaths prefers XDG_CONFIG_HOME / XDG_CACHE_HOME over HOME", () => {
  const paths = resolvePaths({
    HOME: "/home/dtinth",
    XDG_CONFIG_HOME: "/xdg/config",
    XDG_CACHE_HOME: "/xdg/cache",
  });
  assertEquals(paths.configDir, "/xdg/config/claw");
  assertEquals(paths.cacheDir, "/xdg/cache/claw");
});

Deno.test("resolvePaths prefers CLAW_CONFIG_DIR / CLAW_CACHE_DIR over everything else", () => {
  const paths = resolvePaths({
    HOME: "/home/dtinth",
    XDG_CONFIG_HOME: "/xdg/config",
    XDG_CACHE_HOME: "/xdg/cache",
    CLAW_CONFIG_DIR: "/override/config",
    CLAW_CACHE_DIR: "/override/cache",
  });
  assertEquals(paths.configDir, "/override/config");
  assertEquals(paths.cacheDir, "/override/cache");
});

Deno.test("resolvePaths throws when neither HOME nor overrides are set", () => {
  assertThrows(() => resolvePaths({}), PathsError);
});
