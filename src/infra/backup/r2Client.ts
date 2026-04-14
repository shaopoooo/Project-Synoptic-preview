// Cloudflare R2 S3Client factory
// 對應 .claude/plans/i-r2-backup.md Decisions #6（純 JS 技術選型）+ #12（bucket 命名）

import { S3Client } from '@aws-sdk/client-s3';

/**
 * R2 bucket 名稱（Decision #12，2026-04-11 updated）
 *
 * 從 env `R2_BUCKET` 讀取，default fallback 到 `tradingbot-backup`（prod 名稱）。
 * 本地 `.env` 可設 `R2_BUCKET=tradingbot-backup-dev` 讓 dev 環境推/拉 dev bucket；
 * Railway 留空或設為 prod 名稱則走 prod bucket。
 *
 * 因為所有 callsite 都透過 `dotenvx run` 啟動（`package.json` 的 scripts），
 * env 在 ts-node 載入本模組前已就緒 → 用 const 即可，不需要 runtime function。
 */
export const R2_BUCKET: string = process.env.R2_BUCKET ?? 'tradingbot-backup';

/**
 * 建立 R2 S3 client。
 * 讀 env：R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 *
 * 依 architecture.md 規則，caller 負責建立 client 並注入到 r2Mirror / r2Archive，
 * 不在各 service 內部重複建立。
 */
export function createR2Client(): S3Client {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 credentials missing in env. Required: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY',
    );
  }

  return new S3Client({
    region: 'auto',              // R2 不在意 region
    endpoint,                     // 例如 https://<account-id>.r2.cloudflarestorage.com
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,         // R2 需要 path-style addressing
  });
}
