import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

export interface PartnerConfig {
  /** Absolute path to the Obsidian vault root. */
  vaultPath: string;
  /**
   * Folder (relative to the vault) the partner is allowed to write into.
   * Everything outside it is read-only, so your existing notes can never be
   * rewritten by accident.
   */
  writeRoot: string;
  /** Folders to skip while indexing, relative to the vault root. */
  ignore: string[];
  /** Working directory for code-facing tools (Read/Grep/Bash). Optional. */
  projectPath?: string;
  port: number;
  model: string;
  /** Extra persona text appended to the built-in system prompt. */
  personaExtra?: string;
  /** What the partner calls you. */
  userName?: string;
}

const DEFAULTS = {
  writeRoot: "Partner",
  ignore: [".obsidian", ".trash", ".git", "node_modules", ".smart-env"],
  port: 7717,
  model: "claude-opus-5",
} satisfies Partial<PartnerConfig>;

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(1).replace(/^[/\\]/, "")) : p;
}

export function loadConfig(configPath = "config.json"): PartnerConfig {
  const raw: Partial<PartnerConfig> = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};

  const vaultPath = expandHome(process.env.VAULT_PATH ?? raw.vaultPath ?? "");
  if (!vaultPath) {
    throw new Error(
      "Vault path is not set. Copy config.example.json to config.json and set " +
        '"vaultPath", or export VAULT_PATH=/path/to/your/vault',
    );
  }
  const abs = isAbsolute(vaultPath) ? vaultPath : resolve(vaultPath);
  if (!existsSync(abs)) {
    throw new Error(`Vault path does not exist: ${abs}`);
  }

  const projectPath = expandHome(process.env.PROJECT_PATH ?? raw.projectPath ?? "");

  return {
    vaultPath: abs,
    writeRoot: raw.writeRoot ?? DEFAULTS.writeRoot,
    ignore: raw.ignore ?? DEFAULTS.ignore,
    projectPath: projectPath ? resolve(projectPath) : undefined,
    port: Number(process.env.PORT ?? raw.port ?? DEFAULTS.port),
    model: process.env.MODEL ?? raw.model ?? DEFAULTS.model,
    personaExtra: raw.personaExtra,
    userName: raw.userName,
  };
}
