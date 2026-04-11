// R2 Backup 系統的型別定義
// 對應 .claude/plans/i-r2-backup.md Interfaces 段落

/** Mirror sync 計劃（build → upload 的中間結構） */
export interface MirrorPlan {
  toUpload: Array<{
    localPath: string;       // 例如 'data/ohlcv/0x22ae...json'
    r2Key: string;           // 與 localPath 相同（mirror 路徑一致原則）
    sizeBytes: number;
    reason: 'new' | 'size_changed';
  }>;
  unchanged: number;
  totalSizeBytes: number;
}

/** Mirror sync 執行結果 */
export interface MirrorResult {
  startedAt: number;
  finishedAt: number;
  uploadedCount: number;
  uploadedBytes: number;
  failedCount: number;
  errors: Array<{ path: string; message: string }>;
  ok: boolean;               // failedCount === 0
}

/**
 * Analysis flatten upload 結果（Decision #15，R2 backup brainstorm ratification 2026-04-11）
 * 對應 mirrorAnalysisToFlatPrefix() 的輸出
 */
export interface AnalysisMirrorResult {
  startedAt: number;
  finishedAt: number;
  flattenedFiles: Array<{ source: string; r2Key: string; sizeBytes: number }>;
  failedCount: number;
  errors: Array<{ source: string; message: string }>;
  ok: boolean;
}

/** Weekly archive 執行結果 */
export interface ArchiveResult {
  startedAt: number;
  finishedAt: number;
  weekIso: string;           // 例如 "2026-W15"
  archiveSizeBytes: number;
  r2Key: string;             // 例如 "archives/2026-W15.tar.gz"
  ok: boolean;
  error: string | null;
}

/** Restore 結果（mirror / archive 共用，Stage 2 使用） */
export interface RestoreResult {
  startedAt: number;
  finishedAt: number;
  restoredCount: number;
  restoredBytes: number;
  safetyBackupPath: string;  // 例如 'data.backup-1712822400000'
  ok: boolean;
  error: string | null;
}

/** Archive 列表項目（listArchives 的輸出，Stage 2 使用） */
export interface ArchiveListing {
  weekIso: string;
  sizeBytes: number;
  lastModified: Date;
  r2Key: string;
}
