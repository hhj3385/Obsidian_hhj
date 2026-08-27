import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname, posix } from "node:path";
import { existsSync } from "node:fs";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { VaultIndex } from "../vault/index.js";
import { search, recent } from "../vault/search.js";
import { stringifyFrontmatter } from "../vault/frontmatter.js";

/** Notified whenever a tool surfaces a note, so the UI can cite its sources. */
export type CiteFn = (paths: string[]) => void;

const MAX_NOTE_CHARS = 12_000;

function text(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

export function normaliseVaultPath(raw: string): string {
  const p = posix.normalize(raw.trim().replace(/\\/g, "/").replace(/^\/+/, ""));
  return p.endsWith(".md") ? p : `${p}.md`;
}

/** Rejects traversal and anything outside the writable folder. */
export function assertWritable(path: string, writeRoot: string): void {
  if (path.split("/").includes("..")) {
    throw new Error(`Refusing to write outside the vault: ${path}`);
  }
  const root = writeRoot.replace(/^\/+|\/+$/g, "");
  if (root !== "" && path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(
      `Writes are limited to the "${root}/" folder so existing notes stay untouched. ` +
        `Got "${path}". Put the note under "${root}/" instead.`,
    );
  }
}

export function createVaultTools(index: VaultIndex, writeRoot: string, cite: CiteFn) {
  const vaultSearch = tool(
    "vault_search",
    "Search the Obsidian vault by keyword, tag, or folder. This is the primary way to " +
      "recall what the user already thinks about a topic. Prefer it over guessing. " +
      "Returns ranked notes with excerpts; follow up with vault_read for the full text.",
    {
      query: z.string().describe("Keywords to look for. Can be empty when filtering by tag or folder."),
      tag: z.string().optional().describe("Restrict to a tag, e.g. 'project' or 'dev/itsm'. Nested tags match by prefix."),
      folder: z.string().optional().describe("Restrict to a vault folder subtree, e.g. 'Dev'."),
      limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)."),
    },
    async ({ query, tag, folder, limit }) => {
      const hits = search(index, query, { tag, folder, limit });
      cite(hits.map((h) => h.path));
      if (hits.length === 0) {
        return text(
          `No notes matched. Vault has ${index.size} notes. ` +
            `Try vault_map to see what folders and tags exist.`,
        );
      }
      return text(
        hits.map((h) => ({
          path: h.path,
          title: h.title,
          tags: h.tags,
          modified: new Date(h.mtimeMs).toISOString().slice(0, 10),
          excerpt: h.excerpt,
        })),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultRead = tool(
    "vault_read",
    "Read one note in full, with its frontmatter, outgoing links, and backlinks. " +
      "Use after vault_search when an excerpt is not enough.",
    {
      path: z.string().describe("Vault-relative path, e.g. 'Dev/ITSM 설계.md'. The .md suffix is optional."),
    },
    async ({ path }) => {
      const note = index.get(normaliseVaultPath(path)) ?? index.get(path);
      if (!note) {
        const guess = index.resolveLink(path.replace(/\.md$/i, ""));
        const resolved = guess ? index.get(guess) : undefined;
        if (!resolved) return text(`No note at "${path}". Use vault_search to find the right path.`);
        cite([resolved.path]);
        return text(renderNote(resolved, index));
      }
      cite([note.path]);
      return text(renderNote(note, index));
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultNeighbors = tool(
    "vault_neighbors",
    "Walk the link graph around a note — what it links to and what links back to it. " +
      "This is how related thinking is found in this vault: the links are the user's own " +
      "associations, so they beat keyword search for 'what else is connected to this'.",
    {
      path: z.string().describe("Vault-relative path of the starting note."),
      depth: z.number().int().min(1).max(2).optional().describe("Hops to walk (default 1, max 2)."),
    },
    async ({ path, depth }) => {
      const start = index.get(normaliseVaultPath(path));
      if (!start) return text(`No note at "${path}". Use vault_search first.`);

      const hops = depth ?? 1;
      const seen = new Set<string>([start.path]);
      let frontier = [start.path];
      const layers: Array<Array<{ path: string; title: string; relation: string }>> = [];

      for (let d = 0; d < hops; d++) {
        const layer: Array<{ path: string; title: string; relation: string }> = [];
        const next: string[] = [];
        for (const p of frontier) {
          const note = index.get(p);
          if (!note) continue;
          for (const out of note.links) {
            if (seen.has(out)) continue;
            seen.add(out);
            next.push(out);
            layer.push({ path: out, title: index.get(out)?.title ?? out, relation: `${p} → links to` });
          }
          for (const back of index.backlinks(p)) {
            if (seen.has(back)) continue;
            seen.add(back);
            next.push(back);
            layer.push({ path: back, title: index.get(back)?.title ?? back, relation: `links to ← ${p}` });
          }
        }
        if (layer.length > 0) layers.push(layer);
        frontier = next;
        if (frontier.length === 0) break;
      }

      cite([start.path, ...layers.flat().map((n) => n.path)]);
      if (layers.length === 0) {
        return text(`"${start.title}" is an orphan — nothing links to it and it links nowhere.`);
      }
      return text({ start: start.path, layers });
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultRecent = tool(
    "vault_recent",
    "List the most recently modified notes. Use to pick up where the user left off, " +
      "or when they refer to something they were 'just working on'.",
    {
      limit: z.number().int().min(1).max(30).optional().describe("Max results (default 10)."),
      within_days: z.number().int().min(1).optional().describe("Only notes touched in the last N days."),
    },
    async ({ limit, within_days }) => {
      const hits = recent(index, limit ?? 10, within_days);
      cite(hits.map((h) => h.path));
      return text(
        hits.map((h) => ({
          path: h.path,
          title: h.title,
          tags: h.tags,
          modified: new Date(h.mtimeMs).toISOString().slice(0, 16).replace("T", " "),
          excerpt: h.excerpt,
        })),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultMap = tool(
    "vault_map",
    "Get the shape of the vault: note count, folders, and the most used tags. " +
      "Call this once early in a conversation when you are unsure how this vault is organised.",
    {},
    async () => {
      return text({
        noteCount: index.size,
        writableFolder: writeRoot,
        folders: index.folders().slice(0, 40),
        topTags: index.tagCounts().slice(0, 40),
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultWrite = tool(
    "vault_write",
    `Create or update a note. Writes are confined to the "${writeRoot}/" folder, so ` +
      "existing notes are never overwritten. Use this to leave behind what was worked out " +
      "together — a session log, a decision record, a distilled idea — and link it to the " +
      "notes it came from with [[wikilinks]] so it joins the graph instead of floating free.",
    {
      path: z.string().describe(`Vault-relative path inside "${writeRoot}/", e.g. "${writeRoot}/2026-08-27 대화.md".`),
      content: z.string().describe("Markdown body. Use [[wikilinks]] to connect it to source notes."),
      title: z.string().optional().describe("Note title for frontmatter. Defaults to the file name."),
      tags: z.array(z.string()).optional().describe("Tags for frontmatter, without the leading '#'."),
      mode: z
        .enum(["create", "overwrite", "append"])
        .optional()
        .describe("'create' fails if it exists (default), 'append' adds to the end, 'overwrite' replaces."),
    },
    async ({ path, content, title, tags, mode }) => {
      const rel = normaliseVaultPath(path);
      assertWritable(rel, writeRoot);
      const abs = join(index.root, rel);
      const exists = existsSync(abs);
      const how = mode ?? "create";

      if (how === "create" && exists) {
        return text(`"${rel}" already exists. Use mode 'append' or 'overwrite' if that is intended.`);
      }

      await mkdir(dirname(abs), { recursive: true });

      if (how === "append" && exists) {
        const prior = await readFile(abs, "utf8");
        const joined = `${prior.replace(/\s*$/, "")}\n\n${content.trim()}\n`;
        await writeFile(abs, joined, "utf8");
      } else {
        const fm = stringifyFrontmatter({
          title: title ?? rel.split("/").pop()?.replace(/\.md$/, "") ?? rel,
          created: new Date().toISOString().slice(0, 10),
          tags: tags ?? ["partner"],
        });
        await writeFile(abs, `${fm}\n${content.trim()}\n`, "utf8");
      }

      await index.build();
      cite([rel]);
      return text(`Wrote ${rel} (${how}). It is now in the vault and will appear in Obsidian.`);
    },
  );

  return createSdkMcpServer({
    name: "vault",
    version: "0.1.0",
    instructions:
      "Tools for reading and extending the user's Obsidian vault. The vault is the user's " +
      "own accumulated thinking — treat it as the source of truth about what they believe, " +
      "have decided, and are working on.",
    tools: [vaultSearch, vaultRead, vaultNeighbors, vaultRecent, vaultMap, vaultWrite],
  });
}

function renderNote(note: ReturnType<VaultIndex["get"]> & object, index: VaultIndex): string {
  const truncated = note.body.length > MAX_NOTE_CHARS;
  const body = truncated ? `${note.body.slice(0, MAX_NOTE_CHARS)}\n\n…[truncated]` : note.body;
  const backlinks = index.backlinks(note.path);
  const lines = [
    `# ${note.title}`,
    `path: ${note.path}`,
    `modified: ${new Date(note.mtimeMs).toISOString().slice(0, 16).replace("T", " ")}`,
  ];
  if (note.tags.length) lines.push(`tags: ${note.tags.map((t) => `#${t}`).join(" ")}`);
  if (note.links.length) lines.push(`links to: ${note.links.join(", ")}`);
  if (backlinks.length) lines.push(`linked from: ${backlinks.join(", ")}`);
  lines.push("", "---", "", body);
  return lines.join("\n");
}
