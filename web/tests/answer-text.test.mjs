/**
 * Focused tests for how the chat page presents assistant turns.
 *
 * Run from web/ with `npm test` — it runs every .test.mjs under web/tests
 * with Node's built-in runner (no test framework is added: it imports the real
 * `lib/answer-text.ts` via type stripping). Covers:
 *
 *   * genuine abstentions show the concise, user-friendly notice (never the
 *     pipeline's internal wording)
 *   * ordinary answers and the backend's casual replies pass through untouched
 *   * request/security error text is never rewritten as an abstention
 *   * the chat page is wired to presentAssistantText and no longer renders the
 *     internal "Verification:" notice
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ABSTENTION_NOTICE, isAbstention, presentAssistantText } from "../lib/answer-text.ts";

const PAGE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "app", "(shell)", "ask", "page.tsx"),
  "utf8",
);

test("abstention markers render the concise friendly notice", () => {
  const backendNotFound =
    "I couldn't find this in the accessible documents. Please try rephrasing.";
  const backendUnsupported =
    "The accessible documents don't contain enough support for a confident answer.";
  for (const src of [backendNotFound, backendUnsupported, backendNotFound.toUpperCase()]) {
    assert.equal(presentAssistantText(src), ABSTENTION_NOTICE);
    assert.ok(isAbstention(src));
  }
});

test("the notice is the approved copy and leaks no pipeline wording", () => {
  assert.equal(
    ABSTENTION_NOTICE,
    "I couldn't find enough in the documents you can access to answer that " +
      "reliably, so I'd rather not guess. Try a more specific question — a key " +
      "phrase or a document name often helps — or contact your administrator if " +
      "you think a relevant document should be shared with you.",
  );
  const lower = ABSTENTION_NOTICE.toLowerCase();
  for (const internal of [
    "verification",
    "retrieval pipeline",
    "intentional abstention",
    "insufficient supporting evidence",
    "evidence",
    "error",
  ]) {
    assert.ok(!lower.includes(internal), `notice must not mention ${internal}`);
  }
  // friendly + clear: explains why, declines to guess, and says what to try next
  assert.ok(ABSTENTION_NOTICE.includes("I'd rather not guess"));
  assert.ok(ABSTENTION_NOTICE.includes("Try a more specific question"));
  assert.ok(ABSTENTION_NOTICE.includes("contact your administrator"));
});

test("real answers and casual replies pass through unchanged", () => {
  for (const text of [
    "Full-time employees accrue 20 paid vacation days per year.",
    "Hello! How can I help you with your organization's documents today?",
    "Understood — let me know what you'd like to find in your documents.",
    "You're welcome! Let me know if you have any other questions.",
    "Two approvals are required. [1]",
  ]) {
    assert.equal(presentAssistantText(text), text);
  }
});

test("error and security text is never presented as an abstention", () => {
  for (const text of [
    "Request failed (500)",
    "Not authorized",
    "You do not have access to this document",
    "",
  ]) {
    assert.equal(presentAssistantText(text), text);
  }
});

test("chat page renders presentAssistantText and no internal notice", () => {
  assert.ok(
    PAGE.includes("{presentAssistantText(m.content)}"),
    "assistant turns must go through presentAssistantText",
  );
  for (const gone of ["Verification:", "intentional abstention", "ShieldQuestion", "isAbstention("]) {
    assert.ok(!PAGE.includes(gone), `chat page must not contain ${gone}`);
  }
});
