/**
 * A small, forgiving YAML-frontmatter reader.
 *
 * Obsidian frontmatter is overwhelmingly flat scalars and string lists, so a
 * full YAML parser would be a dependency bought for edge cases we do not need.
 * Anything this cannot model is kept verbatim as a string rather than dropped,
 * so no information is silently lost.
 */

export type FrontmatterValue = string | number | boolean | null | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedNote {
  frontmatter: Frontmatter;
  body: string;
  /** Line offset of the body within the original file, for accurate excerpts. */
  bodyLineOffset: number;
}

const FENCE = /^---\r?$|^---$/;

function coerce(raw: string): FrontmatterValue {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;

  // Inline list: [a, b, "c d"]
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s !== "");
  }

  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return unquote(v);
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

export function parseNote(source: string): ParsedNote {
  const lines = source.split("\n");
  const first = lines[0];
  if (first === undefined || !FENCE.test(first)) {
    return { frontmatter: {}, body: source, bodyLineOffset: 0 };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && FENCE.test(line)) {
      end = i;
      break;
    }
  }
  // Unterminated fence: treat the whole file as body rather than eating it.
  if (end === -1) return { frontmatter: {}, body: source, bodyLineOffset: 0 };

  const fm: Frontmatter = {};
  let currentKey: string | null = null;

  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.trim() === "") continue;

    // Block list item belonging to the previous key.
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      const item = unquote((listItem[1] ?? "").trim());
      const existing = fm[currentKey];
      if (Array.isArray(existing)) existing.push(item);
      else fm[currentKey] = [item];
      continue;
    }

    const kv = /^([A-Za-z0-9_\-. ]+):(.*)$/.exec(line);
    if (kv) {
      const key = (kv[1] ?? "").trim();
      const rest = kv[2] ?? "";
      currentKey = key;
      // "key:" with nothing after it opens a block list.
      fm[key] = rest.trim() === "" ? [] : coerce(rest);
      continue;
    }
    currentKey = null;
  }

  return {
    frontmatter: fm,
    body: lines.slice(end + 1).join("\n"),
    bodyLineOffset: end + 1,
  };
}

/** Normalises the many shapes an Obsidian `tags:` field can take. */
export function frontmatterTags(fm: Frontmatter): string[] {
  const out: string[] = [];
  for (const key of ["tags", "tag"]) {
    const v = fm[key];
    if (Array.isArray(v)) out.push(...v);
    else if (typeof v === "string" && v.trim() !== "") {
      out.push(...v.split(/[,\s]+/).filter(Boolean));
    }
  }
  return out.map((t) => t.replace(/^#/, "")).filter(Boolean);
}

export function frontmatterAliases(fm: Frontmatter): string[] {
  const out: string[] = [];
  for (const key of ["aliases", "alias"]) {
    const v = fm[key];
    if (Array.isArray(v)) out.push(...v);
    else if (typeof v === "string" && v.trim() !== "") out.push(v);
  }
  return out.filter(Boolean);
}

/** Serialises frontmatter back to YAML for notes the partner writes. */
export function stringifyFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === "string" && /[:#\[\]{}]/.test(value)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}
