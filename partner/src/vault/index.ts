import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, relative, dirname, basename, sep, posix } from "node:path";
import { parseNote, frontmatterTags, frontmatterAliases } from "./frontmatter.js";
import type { Note } from "./types.js";

/** `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[embed]]` */
const WIKILINK = /!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
/** Inline tags. Obsidian allows nesting with `/` and requires a non-digit start. */
const INLINE_TAG = /(?:^|[\s(\[])#([A-Za-zÀ-￿_][\wÀ-￿/-]*)/g;

const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE = /`[^`\n]*`/g;

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** Strips code so `#include` and `#!/bin/sh` are not mistaken for tags. */
function stripCode(body: string): string {
  return body.replace(FENCED_CODE, " ").replace(INLINE_CODE, " ");
}

export class VaultIndex {
  readonly root: string;
  private readonly ignore: Set<string>;

  private notes = new Map<string, Note>();
  /** Lower-cased basename (and alias) -> vault paths that answer to it. */
  private byName = new Map<string, string[]>();
  private backlinkMap = new Map<string, Set<string>>();
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;

  constructor(root: string, ignore: string[]) {
    this.root = root;
    this.ignore = new Set(ignore);
  }

  get size(): number {
    return this.notes.size;
  }

  async build(): Promise<void> {
    const files = await this.walk(this.root);
    this.notes.clear();
    for (const abs of files) {
      const note = await this.readNote(abs);
      if (note) this.notes.set(note.path, note);
    }
    this.link();
  }

  /**
   * Re-index on external edits so a note you just wrote in Obsidian is visible
   * to the partner in the same breath. Rebuilds are debounced because a single
   * save in Obsidian fires several events.
   */
  startWatching(onChange?: () => void): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename && !filename.toString().endsWith(".md")) return;
        if (this.rescanTimer) clearTimeout(this.rescanTimer);
        this.rescanTimer = setTimeout(() => {
          void this.build().then(() => onChange?.());
        }, 700);
      });
    } catch {
      // Recursive watching is unsupported on some platforms; the index simply
      // stays as it was at startup rather than the server failing to boot.
    }
  }

  stopWatching(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private async walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (this.ignore.has(entry.name)) continue;
      }
      if (this.ignore.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await this.walk(abs)));
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(abs);
    }
    return out;
  }

  private async readNote(abs: string): Promise<Note | null> {
    try {
      const [raw, st] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
      const rel = toPosix(relative(this.root, abs));
      const { frontmatter, body } = parseNote(raw);
      const base = basename(rel, ".md");
      const folder = toPosix(dirname(rel)) === "." ? "" : toPosix(dirname(rel));

      const linkTargets = new Set<string>();
      for (const m of body.matchAll(WIKILINK)) {
        const t = (m[1] ?? "").trim();
        if (t) linkTargets.add(t);
      }

      const tags = new Set(frontmatterTags(frontmatter));
      for (const m of stripCode(body).matchAll(INLINE_TAG)) {
        const t = m[1];
        if (t) tags.add(t);
      }

      const fmTitle = frontmatter["title"];
      return {
        path: rel,
        basename: base,
        folder,
        title: typeof fmTitle === "string" && fmTitle.trim() !== "" ? fmTitle : base,
        frontmatter,
        tags: [...tags],
        aliases: frontmatterAliases(frontmatter),
        linkTargets: [...linkTargets],
        links: [],
        body,
        mtimeMs: st.mtimeMs,
        size: st.size,
      };
    } catch {
      return null;
    }
  }

  /** Resolves wikilink targets to paths and inverts them into a backlink map. */
  private link(): void {
    this.byName.clear();
    this.backlinkMap.clear();

    const add = (name: string, path: string) => {
      const key = name.toLowerCase();
      const list = this.byName.get(key);
      if (list) list.push(path);
      else this.byName.set(key, [path]);
    };
    for (const note of this.notes.values()) {
      add(note.basename, note.path);
      for (const alias of note.aliases) add(alias, note.path);
    }

    for (const note of this.notes.values()) {
      const resolved = new Set<string>();
      for (const target of note.linkTargets) {
        const hit = this.resolveLink(target, note.path);
        if (hit) resolved.add(hit);
      }
      note.links = [...resolved];
      for (const target of note.links) {
        const set = this.backlinkMap.get(target);
        if (set) set.add(note.path);
        else this.backlinkMap.set(target, new Set([note.path]));
      }
    }
  }

  /**
   * Obsidian resolves `[[Foo]]` by basename, preferring the note nearest the
   * linking note when several share a name. Paths may also be given directly.
   */
  resolveLink(target: string, fromPath = ""): string | null {
    const clean = target.trim().replace(/\.md$/i, "");
    if (clean === "") return null;

    const direct = `${clean}.md`;
    if (this.notes.has(direct)) return direct;

    if (fromPath) {
      const sibling = posix.normalize(posix.join(posix.dirname(fromPath), direct));
      if (this.notes.has(sibling)) return sibling;
    }

    const candidates = this.byName.get(basename(clean).toLowerCase());
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0] ?? null;

    const fromDir = fromPath ? posix.dirname(fromPath) : "";
    let best = candidates[0] ?? null;
    let bestScore = -1;
    for (const c of candidates) {
      const shared = sharedPrefixDepth(fromDir, posix.dirname(c));
      if (shared > bestScore) {
        bestScore = shared;
        best = c;
      }
    }
    return best;
  }

  get(path: string): Note | undefined {
    return this.notes.get(path) ?? this.notes.get(`${path.replace(/\.md$/i, "")}.md`);
  }

  all(): Note[] {
    return [...this.notes.values()];
  }

  backlinks(path: string): string[] {
    return [...(this.backlinkMap.get(path) ?? [])];
  }

  /** Tag inventory, most used first — how the partner orients in a new vault. */
  tagCounts(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    for (const note of this.notes.values()) {
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  folders(): Array<{ folder: string; count: number }> {
    const counts = new Map<string, number>();
    for (const note of this.notes.values()) {
      const f = note.folder === "" ? "/" : note.folder;
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([folder, count]) => ({ folder, count }))
      .sort((a, b) => b.count - a.count);
  }
}

function sharedPrefixDepth(a: string, b: string): number {
  const as = a === "." ? [] : a.split("/").filter(Boolean);
  const bs = b === "." ? [] : b.split("/").filter(Boolean);
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
  return i;
}
