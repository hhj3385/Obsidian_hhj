import type { Frontmatter } from "./frontmatter.js";

export interface Note {
  /** Path relative to the vault root, using forward slashes. e.g. "Dev/ITSM.md" */
  path: string;
  /** File name without the .md extension. e.g. "ITSM" */
  basename: string;
  /** Folder relative to the vault root, "" for the root. */
  folder: string;
  title: string;
  frontmatter: Frontmatter;
  tags: string[];
  aliases: string[];
  /** Raw outgoing wikilink targets, before resolution. */
  linkTargets: string[];
  /** Resolved outgoing links, as vault-relative paths. */
  links: string[];
  body: string;
  mtimeMs: number;
  size: number;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  tags: string[];
  /** A short passage around the strongest match. */
  excerpt: string;
  mtimeMs: number;
}
