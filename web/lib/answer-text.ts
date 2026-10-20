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

/** Shown in place of the pipeline's abstention wording — no internal detail. */
export const ABSTENTION_NOTICE =
  "I couldn't find enough information in the documents you can access to answer " +
  "that reliably. Please try a more specific question or contact your administrator.";

/** Text rendered for an assistant turn: friendly notice on abstention, else as-is. */
export function presentAssistantText(text: string): string {
  return isAbstention(text) ? ABSTENTION_NOTICE : text;
}
