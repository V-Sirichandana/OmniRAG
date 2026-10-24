/**
 * Pure presentation helpers for assistant turns on the chat page.
 *
 * Deliberately free of React/JSX so `node --test` can import it directly
 * (Node's built-in TypeScript type stripping) and exercise the abstention
 * presentation without a component renderer.
 *
 * This only decides WHAT text is shown. The backend keeps full ownership of
 * the abstention decision and every evidence-sufficiency check; real request
 * failures and security errors never pass through here (they render through
 * ErrorNote / errorToMessage instead).
 */

/** Known abstention phrasings returned by the backend verification pipeline. */
export function isAbstention(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("couldn't find this") || t.includes("don't contain enough support");
}

/**
 * Shown in place of the pipeline's abstention wording — no internal detail.
 * Friendly and actionable: says why (not enough support in the documents the
 * employee can access), that we won't guess, and what to try next.
 */
export const ABSTENTION_NOTICE =
  "I couldn't find enough in the documents you can access to answer that " +
  "reliably, so I'd rather not guess. Try a more specific question — a key " +
  "phrase or a document name often helps — or contact your administrator if " +
  "you think a relevant document should be shared with you.";

/** Text rendered for an assistant turn: friendly notice on abstention, else as-is. */
export function presentAssistantText(text: string): string {
  return isAbstention(text) ? ABSTENTION_NOTICE : text;
}
