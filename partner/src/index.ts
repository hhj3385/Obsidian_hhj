import { loadConfig } from "./config.js";
import { VaultIndex } from "./vault/index.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const index = new VaultIndex(config.vaultPath, config.ignore);
  const started = Date.now();
  await index.build();
  console.log(`볼트 인덱싱 완료: 노트 ${index.size}개 (${Date.now() - started}ms)`);

  if (index.size === 0) {
    console.warn(
      `\n  경고: "${config.vaultPath}" 에서 .md 파일을 못 찾았습니다.\n` +
        "  config.json 의 vaultPath 가 볼트 루트를 가리키는지 확인해 주세요.\n",
    );
  }

  index.startWatching(() => {
    console.log(`볼트 변경 감지 → 재인덱싱 (노트 ${index.size}개)`);
  });

  startServer(config, index);

  const shutdown = () => {
    index.stopWatching();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`\n오류: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
