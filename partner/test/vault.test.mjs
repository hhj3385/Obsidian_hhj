import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VaultIndex } from "../dist/vault/index.js";
import { search, recent } from "../dist/vault/search.js";
import { parseNote, frontmatterTags } from "../dist/vault/frontmatter.js";
import { assertWritable, normaliseVaultPath } from "../dist/tools/vault-tools.js";

let root;
let index;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "vault-test-"));
  await mkdir(join(root, "Dev"), { recursive: true });
  await mkdir(join(root, "Reading"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });

  await writeFile(
    join(root, "Dev", "ITSM 설계.md"),
    `---
title: ITSM 플랫폼 설계
tags: [dev, itsm, 온프레미스]
aliases: ["다누리 설계"]
---

온프레미스 원칙 때문에 외부 CDN을 못 쓴다. [[Tailwind 로컬 빌드]] 방식으로 간다.
관련: [[eGovFrame 정리]] 그리고 [[없는 노트]]

\`\`\`bash
#!/bin/sh
#include <stdio.h>
\`\`\`
`,
  );

  await writeFile(
    join(root, "Dev", "Tailwind 로컬 빌드.md"),
    `---
tags:
  - dev
  - frontend
---
[[ITSM 설계]] 에서 필요해서 정리함. #실무
`,
  );

  await writeFile(join(root, "Dev", "eGovFrame 정리.md"), "표준프레임워크 4.2. #legacy\n");
  await writeFile(join(root, "Reading", "사고의 도구.md"), "---\ntags: [reading]\n---\n좋은 파트너는 동의하지 않는다.\n");
  await writeFile(join(root, ".obsidian", "workspace.md"), "should be ignored\n");

  index = new VaultIndex(root, [".obsidian", ".trash", ".git"]);
  await index.build();
});

describe("frontmatter", () => {
  test("reads inline lists and block lists alike", () => {
    assert.deepEqual(parseNote("---\ntags: [a, b]\n---\nbody").frontmatter.tags, ["a", "b"]);
    assert.deepEqual(parseNote("---\ntags:\n  - a\n  - b\n---\nbody").frontmatter.tags, ["a", "b"]);
  });

  test("an unterminated fence is body, not a swallowed file", () => {
    const parsed = parseNote("---\ntitle: x\nno closing fence");
    assert.deepEqual(parsed.frontmatter, {});
    assert.match(parsed.body, /no closing fence/);
  });

  test("strips a leading # from tags", () => {
    assert.deepEqual(frontmatterTags({ tags: ["#a", "b"] }), ["a", "b"]);
  });

  test("a file with no frontmatter keeps its whole body", () => {
    const parsed = parseNote("just text\nmore text");
    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, "just text\nmore text");
  });
});

describe("indexing", () => {
  test("indexes markdown and skips ignored folders", () => {
    assert.equal(index.size, 4);
  });

  test("prefers a frontmatter title over the file name", () => {
    assert.equal(index.get("Dev/ITSM 설계.md").title, "ITSM 플랫폼 설계");
  });

  test("does not mistake shell and C directives in code blocks for tags", () => {
    const tags = index.get("Dev/ITSM 설계.md").tags;
    assert.deepEqual(tags.sort(), ["dev", "itsm", "온프레미스"]);
    assert.ok(!tags.some((t) => t.includes("include") || t.includes("bin")));
  });

  test("collects inline tags from the body", () => {
    assert.ok(index.get("Dev/Tailwind 로컬 빌드.md").tags.includes("실무"));
  });
});

describe("link graph", () => {
  test("resolves wikilinks to paths", () => {
    assert.deepEqual(index.get("Dev/ITSM 설계.md").links.sort(), [
      "Dev/Tailwind 로컬 빌드.md",
      "Dev/eGovFrame 정리.md",
    ]);
  });

  test("drops links to notes that do not exist", () => {
    assert.ok(!index.get("Dev/ITSM 설계.md").links.some((l) => l.includes("없는 노트")));
  });

  test("builds backlinks", () => {
    assert.deepEqual(index.backlinks("Dev/Tailwind 로컬 빌드.md"), ["Dev/ITSM 설계.md"]);
  });

  test("resolves an alias to its note", () => {
    assert.equal(index.resolveLink("다누리 설계"), "Dev/ITSM 설계.md");
  });
});

describe("search", () => {
  test("matches Korean substrings across particle boundaries", () => {
    // "온프레미스" must hit "온프레미스 원칙" — whole-word matching would miss it.
    const hits = search(index, "온프레미스");
    assert.ok(hits.some((h) => h.path === "Dev/ITSM 설계.md"));
  });

  test("ranks a title match above a passing body mention", () => {
    const hits = search(index, "설계");
    assert.equal(hits[0].path, "Dev/ITSM 설계.md");
  });

  test("filters by tag", () => {
    const hits = search(index, "", { tag: "dev" });
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.path.startsWith("Dev/")));
  });

  test("filters by folder", () => {
    const hits = search(index, "", { folder: "Reading" });
    assert.deepEqual(hits.map((h) => h.path), ["Reading/사고의 도구.md"]);
  });

  test("returns nothing rather than everything for an unmatched query", () => {
    assert.equal(search(index, "존재하지않는키워드xyz").length, 0);
  });

  test("recent() respects its limit", () => {
    assert.equal(recent(index, 2).length, 2);
  });
});

describe("write guard", () => {
  const allowed = ["Partner/ok.md", "Partner/sub/deep.md", "Partner/ok", "/Partner/abs.md"];
  const refused = [
    "Dev/ITSM 설계.md",
    "root.md",
    "../../etc/evil.md",
    "Partner/../Dev/sneaky.md",
    "Partnerish/nope.md",
  ];

  for (const path of allowed) {
    test(`allows ${path}`, () => {
      assert.doesNotThrow(() => assertWritable(normaliseVaultPath(path), "Partner"));
    });
  }

  for (const path of refused) {
    test(`refuses ${path}`, () => {
      assert.throws(() => assertWritable(normaliseVaultPath(path), "Partner"));
    });
  }

  test("appends .md when it is missing", () => {
    assert.equal(normaliseVaultPath("Partner/note"), "Partner/note.md");
    assert.equal(normaliseVaultPath("Partner/note.md"), "Partner/note.md");
  });
});

test("cleanup", async () => {
  await rm(root, { recursive: true, force: true });
});
