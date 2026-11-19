/**
 * What a typed message says about the Notion brain (docs/spotlight.md#moving-a-brain-to-notion): the shell Spotlight decides
 * from the words, so no model runs and nothing is spent, as `askKind` and `agentChangeAsk` do. Pure, no zod, English words
 * only. A question about Notion's pages ("what does our Notion say about refunds") is not one of these: it stays Ask's.
 */
export type NotionBrainAsk =
  /** A string shaped like a Notion key: it wins over everything and is never sent anywhere. */
  | { kind: "key" }
  /** Keep, move, put, sync, link or connect the brain to or in Notion; `page` is the raw link or id when the text names one. */
  | { kind: "link"; page?: string }
  /** Whether the brain is in sync with Notion, when it last synced, what is wrong with the sync. */
  | { kind: "status" };

/** A Notion key by its shape: `ntn_` or `secret_` and 40 or more letters and digits. */
const KEY_SHAPE = /(?<![A-Za-z0-9])(?:ntn_|secret_)[A-Za-z0-9]{40,}/g;

/** What a hidden key reads as. */
export const HIDDEN_KEY = "[a Notion key, hidden]";

/** The text with each key-shaped string hidden. */
export const hideNotionKeys = (text: string): string =>
  text.replace(KEY_SHAPE, HIDDEN_KEY);

const PAGE_LINK =
  /https?:\/\/(?:[\w-]+\.)?notion\.(?:so|com|site)\/[^\s<>"')\]]+/i;
const PAGE_ID = /(?<![0-9a-f-])[0-9a-f]{32}(?![0-9a-f])/i;

/** The page the text names: a notion.so / notion.com / notion.site link, else a 32-hex id (raw; the check route parses it). */
function pageIn(text: string): string | undefined {
  const link = PAGE_LINK.exec(text)?.[0]?.replace(/[.,;:!?]+$/, "");
  return link ?? PAGE_ID.exec(text)?.[0];
}

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(PAGE_LINK, " ")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** "is the brain in sync with Notion", "when did it last sync to Notion", "what is wrong with the Notion sync". */
const STATUS = [
  /^(?:is|are|isn't|aren't)\b.*\b(?:in sync|synced|syncing|up to date|out of date|stale|in notion)\b/,
  /^(?:when|what time)\b.*\bsync(?:ed)?\b/,
  /^(?:what(?:'s| is| went| has gone)?|why)\b.*\b(?:wrong|failing|failed|broken|stuck|not syncing|isn't syncing)\b.*\bsync/,
  /^(?:what(?:'s| is| went| has gone)?|why)\b.*\bsync\b.*\b(?:wrong|failing|failed|broken|stuck)\b/,
  /^(?:how|what)(?:'s| is)?\b.*\bnotion sync\b/,
  /\bnotion sync (?:status|problems?|errors?)\b/,
  /^(?:check|show|tell me)\b.*\b(?:notion sync|sync status|is it in sync)\b/,
];

const LINK_VERB =
  /\b(?:keep|move|put|sync|link|connect|copy|store|host|publish|mirror|push|switch|migrate|set up|setup)\b/;
const QUESTION_OPENER = /^(?:what|why|how|which|who|where|when)\b/;

/** The Notion-brain ask in `text`, or undefined (an ordinary question or request). */
export function notionBrainAsk(text: string): NotionBrainAsk | undefined {
  KEY_SHAPE.lastIndex = 0;
  if (new RegExp(KEY_SHAPE.source).test(text)) return { kind: "key" };
  const words = norm(text.replace(/^[\s"'“‘(]+/, ""));
  if (!words.includes("notion")) return undefined;
  // Without "brain" or "sync" it is about Notion's pages, not the brain's home.
  if (!/\bbrain\b/.test(words) && !/\bsync/.test(words)) return undefined;
  if (STATUS.some((rule) => rule.test(words))) return { kind: "status" };
  const body = words.replace(
    /^(?:please|pls|kindly|ok(?:ay)?|so|hey|just|now|also|then|and|go ahead and|(?:can|could|would|will) (?:you|we|i)(?: please)?|i(?:'d| would)? (?:want|need|like)(?: you| it| this| that)? to|i (?:want|need)|let's)\b[,\s]*/g,
    "",
  );
  if (
    QUESTION_OPENER.test(body) ||
    !/\bbrain\b/.test(body) ||
    !LINK_VERB.test(body)
  )
    return undefined;
  const page = pageIn(text);
  return { kind: "link", ...(page && { page }) };
}
