import type { VaultIndex } from "./index.js";
import type { Note, SearchHit } from "./types.js";

export interface SearchOptions {
  limit?: number;
  /** Restrict to notes carrying this tag (nested tags match by prefix). */
  tag?: string;
  /** Restrict to a folder subtree, vault-relative. */
  folder?: string;
}

const WEIGHT = { title: 12, alias: 10, tag: 8, folder: 3, body: 2 } as const;
const BODY_CAP = 12;
const EXCERPT_RADIUS = 130;

/**
 * Terms are matched as substrings rather than whole words. Korean is written
 * without spaces between a stem and its particles, so word-boundary matching
 * would miss "볼트에서" for the query "볼트" — the common case in this vault.
 */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,./\\()[\]{}"'`|]+/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter((t) => t.length > 0)
    .filter((t, _i, arr) => t.length >= 2 || arr.every((x) => x.length < 2));
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

function excerptAround(body: string, needles: string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const n of needles) {
    const i = lower.indexOf(n);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) {
    return body.slice(0, EXCERPT_RADIUS * 2).replace(/\s+/g, " ").trim();
  }
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(body.length, at + EXCERPT_RADIUS);
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < body.length ? "…" : ""}`;
}

function scoreNote(note: Note, ts: string[]): number {
  const title = note.title.toLowerCase();
  const base = note.basename.toLowerCase();
  const folder = note.folder.toLowerCase();
  const body = note.body.toLowerCase();
  const tags = note.tags.map((t) => t.toLowerCase());
  const aliases = note.aliases.map((a) => a.toLowerCase());

  let score = 0;
  for (const t of ts) {
    if (title.includes(t) || base.includes(t)) score += WEIGHT.title;
    if (aliases.some((a) => a.includes(t))) score += WEIGHT.alias;
    if (tags.some((tag) => tag.includes(t))) score += WEIGHT.tag;
    if (folder.includes(t)) score += WEIGHT.folder;
    score += Math.min(countOccurrences(body, t), BODY_CAP) * WEIGHT.body;
  }
  // Notes matching every term beat notes matching only one, at equal volume.
  const covered = ts.filter(
    (t) => title.includes(t) || body.includes(t) || tags.some((tag) => tag.includes(t)),
  ).length;
  if (ts.length > 1 && covered === ts.length) score *= 1.5;
  return score;
}

export function search(index: VaultIndex, query: string, opts: SearchOptions = {}): SearchHit[] {
  const ts = terms(query);
  const limit = opts.limit ?? 8;
  const tagFilter = opts.tag?.toLowerCase().replace(/^#/, "");
  const folderFilter = opts.folder?.toLowerCase().replace(/^\/+|\/+$/g, "");

  const hits: SearchHit[] = [];
  for (const note of index.all()) {
    if (tagFilter) {
      const ok = note.tags.some((t) => {
        const lt = t.toLowerCase();
        return lt === tagFilter || lt.startsWith(`${tagFilter}/`);
      });
      if (!ok) continue;
    }
    if (folderFilter) {
      const lf = note.folder.toLowerCase();
      if (lf !== folderFilter && !lf.startsWith(`${folderFilter}/`)) continue;
    }

    // A tag- or folder-only query is a valid browse, so surface the matches.
    const score = ts.length === 0 ? 1 : scoreNote(note, ts);
    if (score <= 0) continue;
    hits.push({
      path: note.path,
      title: note.title,
      score,
      tags: note.tags,
      excerpt: excerptAround(note.body, ts),
      mtimeMs: note.mtimeMs,
    });
  }

  hits.sort((a, b) => (b.score === a.score ? b.mtimeMs - a.mtimeMs : b.score - a.score));
  return hits.slice(0, limit);
}

export function recent(index: VaultIndex, limit = 10, withinDays?: number): SearchHit[] {
  const cutoff = withinDays ? Date.now() - withinDays * 86_400_000 : 0;
  return index
    .all()
    .filter((n) => n.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((n) => ({
      path: n.path,
      title: n.title,
      score: 0,
      tags: n.tags,
      excerpt: n.body.slice(0, 220).replace(/\s+/g, " ").trim(),
      mtimeMs: n.mtimeMs,
    }));
}
