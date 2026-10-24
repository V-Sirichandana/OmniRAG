/**
 * Regression tests for the stability fixes (source-contract level).
 *
 * Run from web/ with `npm test` (Node's built-in runner; no dependencies).
 *
 * The chat/library/settings fixes are React-boundary behaviour, so instead of
 * a component renderer this file asserts the exact source contracts that fixed
 * the bugs — a revert of any fix fails here. The pure presentation logic has
 * its own behavioural suite in answer-text.test.mjs.
 *
 * Fixes covered:
 *   1. chat: a failed send restores the typed question (never erases it)
 *   2. chat: 1-char / >2000-char input is rejected client-side with a clear
 *      message before the request (matching the API's min_length=2 contract)
 *   3. chat: opening/switching a conversation clears a stale error banner
 *   4. chat: Enter during an IME composition no longer sends the message
 *   5. chat: a slow conversation fetch cannot wipe a send in flight
 *   6. library: ?q= deep-link applies when already on /library
 *   7. library: document downloads honor NEXT_PUBLIC_API_BASE
 *   8. library + departments: a successful reload clears the error banner
 *   9. settings: "Sign in from another device" actually signs out
 *  10. admin: clipboard copy failures are handled (no unhandled rejection)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const ask = read("app/(shell)/ask/page.tsx");
const library = read("app/(shell)/library/page.tsx");
const departments = read("app/(shell)/departments/page.tsx");
const settings = read("app/(shell)/settings/page.tsx");
const admin = read("app/(shell)/admin/page.tsx");
const api = read("lib/api.ts");

test("chat: failed send restores the typed question", () => {
  assert.ok(
    ask.includes("setInput((cur) => (cur.trim() ? cur : q))"),
    "catch must give the question back when the composer is still empty",
  );
});

test("chat: length limits are enforced client-side before any state change", () => {
  assert.ok(ask.includes("q.length < 2 || q.length > 2000"), "2..2000 contract check");
  assert.ok(
    ask.indexOf("q.length < 2 || q.length > 2000") < ask.indexOf('setInput("");'),
    "the check must run before the composer is cleared",
  );
  assert.ok(ask.includes("Please type at least 2 characters."), "clear one-char message");
});

test("chat: switching conversations clears a stale error banner", () => {
  assert.ok(
    ask.includes('setError(""); // a previous failure must not linger'),
    "conversation-load effect must reset the error",
  );
});

test("chat: Enter during IME composition does not send", () => {
  assert.ok(ask.includes("!e.nativeEvent.isComposing"), "isComposing guard");
});

test("chat: a send in flight cannot be wiped by a conversation refetch", () => {
  assert.ok(
    ask.includes("!busyRef.current && setMessages(m)"),
    "loader must not replace the transcript while sending",
  );
  assert.ok(ask.includes("const busyRef = useRef(false);"), "busyRef exists");
});

test("library: ?q= deep-link is re-applied on URL change", () => {
  assert.ok(
    library.includes('setQ(search.get("q") ?? "")'),
    "q is synced from the URL, not only on first mount",
  );
  assert.ok(library.includes("}, [search]);"), "sync effect watches searchParams");
});

test("library: downloads use the configured API base", () => {
  assert.ok(
    library.includes("API_BASE}/api/documents/${d.id}/download"),
    "download must honor NEXT_PUBLIC_API_BASE",
  );
  assert.ok(library.includes("API_BASE"), "API_BASE imported");
});

test("library and departments: successful reloads clear the error banner", () => {
  for (const [name, src] of [["library", library], ["departments", departments]]) {
    assert.ok(
      src.includes('setError(""); // a successful reload'),
      `${name} load() must clear a stale banner on success`,
    );
  }
});

test("settings: sign-in-from-another-device actually signs out", () => {
  assert.ok(settings.includes("onClick={logout}"), "button calls logout()");
  assert.ok(
    !settings.includes('router.push("/login")'),
    "must not bounce straight back to the workspace",
  );
});

test("admin: clipboard copy handles rejection", () => {
  assert.ok(admin.includes(".catch(() => {});"), "writeText rejection is handled");
});

test("lib/api.ts exports API_BASE and keeps a single origin constant", () => {
  assert.ok(api.includes("export const API_BASE"), "API_BASE is exported");
  assert.ok(!api.includes("const BASE ="), "old private BASE is gone");
});
