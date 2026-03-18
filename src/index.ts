import cron from 'node-cron';
import { PoolScanner } from './services/PoolScanner';
import { BBEngine, getPriceBufferSnapshot, restorePriceBuffer, refreshPriceBuffer } from './services/BBEngine';
import { RiskManager } from './services/RiskManager';
import { RebalanceService } from './services/rebalance';
import { PnlCalculator } from './services/PnlCalculator';
import { TelegramBotService, minutesToCron, VALID_INTERVALS, IntervalMinutes } from './bot/TelegramBot';
import { positionScanner } from './services/PositionScanner';
import { PositionAggregator } from './services/PositionAggregator';
import { createServiceLogger } from './utils/logger';
import { fetchGasCostUSD } from './utils/rpcProvider';
import { fetchTokenPrices } from './utils/tokenPrices';
import { loadState, saveState, restoreState } from './utils/stateManager';
import { bandwidthTracker } from './utils/BandwidthTracker';
import { appState, ucWalletAddresses, ucTrackedPositions, ucPoolList } from './utils/AppState';
import { config, validateEnv } from './config';
import { PoolStats, BBResult, PositionRecord, PositionState, RiskAnalysis } from './types';

const log = createServiceLogger('Main');
const botService = new TelegramBotService();

// ── 排程管理 ──────────────────────────────────────────────────────────────────
let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;
let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

let isCycleRunning = false;

function buildCronJob() {
  return cron.schedule(minutesToCron(currentIntervalMinutes), async () => {
    if (isCycleRunning) {
      log.warn(`⚠️  上一個週期尚未完成，跳過本次觸發（排程重疊保護）`);
      return;
    }
    isCycleRunning = true;
    try {
      log.section(`${currentIntervalMinutes}m cycle`);
      await runTokenPriceFetcher().catch((e) => log.error(`Cron TokenPriceFetcher: ${e}`));
      await runPoolScanner().catch((e) => log.error(`Cron PoolScanner: ${e}`));
      await runBBEngine().catch((e) => log.error(`Cron BBEngine: ${e}`));
      await runPositionScanner().catch((e) => log.error(`Cron PositionScanner: ${e}`));
      await runRiskManager().catch((e) => log.error(`Cron RiskManager: ${e}`));
      await runBotService().catch((e) => log.error(`Cron BotService: ${e}`));
      const triggerStateSave = async () => saveState(
        getPriceBufferSnapshot(),
        bandwidthTracker.snapshot(),
        appState.userConfig,
      );
      await triggerStateSave().catch((e) => log.error(`State save: ${e}`));
      log.section('cycle end');
      positionScanner.fillMissingTimestamps(triggerStateSave).catch((e) => log.error(`TimestampFiller: ${e}`));
    } finally {
      isCycleRunning = false;
    }
  });
}

function reschedule(minutes: number) {
  if (!VALID_INTERVALS.includes(minutes as typeof VALID_INTERVALS[number])) return;
  scheduledTask?.stop();
  currentIntervalMinutes = minutes;
  scheduledTask = buildCronJob();
  log.info(`🔄 排程已更新為每 ${minutes} 分鐘 (cron: ${minutesToCron(minutes)})`);
}

// 嚴重錯誤告警（每類每 30 分鐘至多一次，避免洗版）
const alertCooldowns = new Map<string, number>();
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
async function sendCriticalAlert(key: string, message: string) {
  const last = alertCooldowns.get(key) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return;
  alertCooldowns.set(key, Date.now());
  await botService.sendAlert(`🚨 <b>DexBot 告警</b>\n${message}`).catch(() => { });
}

let activeTasks = 0;
let isStartupComplete = false;

// 0. Token Price Fetcher
async function runTokenPriceFetcher() {
  try {
    await fetchTokenPrices();
  } catch (e) {
    log.error(`TokenPriceFetcher: ${e}`);
  }
}

// 1. Pool Scanner
async function runPoolScanner() {
  activeTasks++;
  try {
    const pools = await PoolScanner.scanAllCorePools(ucPoolList(appState.userConfig));
    if (pools.length === 0) {
      log.warn('no pools returned — subgraph or RPC error');
      await sendCriticalAlert('pool_scanner_empty', 'PoolScanner 無法取得任何池子資料，請確認 RPC / DexScreener 連線狀態。');
      return;
    }
    pools.sort((a, b) => b.apr - a.apr);
    appState.pools = pools;
    appState.lastUpdated.poolScanner = Date.now();
    const top = appState.pools[0];
    const topTvl = top.tvlUSD >= 1000 ? `$${(top.tvlUSD / 1000).toFixed(0)}K` : `$${top.tvlUSD.toFixed(0)}`;
    log.info(`✅ pools(${appState.pools.length})  top: ${top.dex} ${(top.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}% — APR ${(top.apr * 100).toFixed(1)}%  TVL ${topTvl}`);
  } catch (error) {
    log.error(`PoolScanner: ${error}`);
  } finally { activeTasks--; }
}

// 2. Position Scanner — fetchAll → aggregateAll → enrich PnL → updatePositions
async function runPositionScanner() {
  activeTasks++;
  try {
    const rawPositions = await positionScanner.fetchAll();
    const assembled = await PositionAggregator.aggregateAll(rawPositions, appState.bbs, appState.pools);

    // PnL enrichment — computed here because assembler is scope-limited to USD values
    const gasCostUSD = await fetchGasCostUSD().catch(() => config.DEFAULT_GAS_COST_USD);
    for (const rec of assembled) {
      rec.initialCapital = PnlCalculator.getInitialCapital(rec.tokenId);
      const exactIL = PnlCalculator.calculateAbsolutePNL(rec.tokenId, rec.positionValueUSD, rec.unclaimedFeesUSD);
      rec.ilUSD = exactIL;
      const openInfo = PnlCalculator.calculateOpenInfo(rec.tokenId, rec.openTimestampMs, exactIL);
      if (openInfo) {
        rec.openedDays = openInfo.days;
        rec.openedHours = openInfo.hours;
        rec.profitRate = openInfo.profitRate;
      }
    }

    positionScanner.updatePositions(assembled);

    const positions = positionScanner.getTrackedPositions();
    appState.positions = positions.filter((p) => Number(p.liquidity) > 0);
    appState.lastUpdated.positionScanner = Date.now();
    log.info(`✅ positions  active ${appState.positions.length}/${positions.length} tracked`);

    appState.pruneStaleBBs();
  } catch (error) {
    log.error(`PositionScanner: ${error}`);
    await sendCriticalAlert('position_scanner_failed', `所有倉位掃描失敗，本週期資料未更新。\n錯誤: ${error}`);
  } finally { activeTasks--; }
}

// 3. BBEngine
async function runBBEngine() {
  activeTasks++;
  try {
    const poolsToProcess = new Map<string, PoolStats>();

    for (const pos of appState.positions) {
      const poolData = appState.pools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );
      if (poolData) poolsToProcess.set(poolData.id.toLowerCase(), poolData);
    }

    for (const [poolAddress, poolData] of poolsToProcess.entries()) {
      let posTickSpacing = 10;
      if (poolData.feeTier === 0.0001) posTickSpacing = 1;
      else if (poolData.feeTier === 0.003) posTickSpacing = 60;
      else if (poolData.feeTier === 0.000085) posTickSpacing = 1; // Aerodrome 0.0085%

      const bb = await BBEngine.computeDynamicBB(poolData.id, poolData.dex, posTickSpacing, poolData.tick);
      if (bb) appState.bbs[poolAddress] = bb;
    }
    appState.lastUpdated.bbEngine = Date.now();
    log.info(`✅ BB bands computed for ${poolsToProcess.size} pool(s)`);
  } catch (error) {
    log.error(`BBEngine: ${error}`);
  } finally { activeTasks--; }
}

// 4. RiskManager + Rebalance
async function runRiskManager() {
  activeTasks++;
  try {
    const gasCostUSD = await fetchGasCostUSD().catch(() => config.DEFAULT_GAS_COST_USD);
    for (const pos of appState.positions) {
      const poolData = appState.pools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );
      if (!poolData) continue;

      const bb = appState.bbs[poolData.id.toLowerCase()];
      if (!bb) continue;

      const poolKey = poolData.id.toLowerCase();
      const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
      const avg30DBandwidth = bandwidthTracker.update(poolKey, currentBandwidth);

      const positionState: PositionState = {
        capital: pos.initialCapital ?? pos.positionValueUSD,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        unclaimedFees: pos.unclaimedFeesUSD,
        cumulativeIL: pos.ilUSD ?? 0,
        feeRate24h: poolData.apr / 365,
      };

      const risk = RiskManager.analyzePosition(
        positionState, bb, poolData.dailyFeesUSD, avg30DBandwidth, currentBandwidth, gasCostUSD
      );

      pos.riskAnalysis = risk;
      pos.overlapPercent = risk.driftOverlapPct;
      pos.breakevenDays = risk.ilBreakevenDays;
      pos.healthScore = risk.healthScore;

      // Rebalance — computed after risk so breakevenDays is the correct analysed value
      const rb = RebalanceService.getRebalanceSuggestion(
        parseFloat(pos.currentPriceStr),
        bb,
        pos.unclaimedFeesUSD,
        pos.breakevenDays,
        pos.positionValueUSD,
        pos.token0Symbol,
        pos.token1Symbol,
        gasCostUSD,
        parseFloat(pos.bbMinPrice || '0'),
        parseFloat(pos.bbMaxPrice || '0'),
      );
      pos.rebalance = rb ?? undefined;
    }
    appState.lastUpdated.riskManager = Date.now();
    log.info(`✅ risk analysis updated for ${appState.positions.length} position(s)`);

    // Log snapshots here — after both BBEngine and RiskManager have enriched the positions,
    // so positions.log reflects correct Health Score, Drift %, and Breakeven values.
    const bbForLog = Object.values(appState.bbs)[0] ?? null;
    positionScanner.logSnapshots(appState.positions, bbForLog, appState.bbKLowVol, appState.bbKHighVol);
  } catch (error) {
    log.error(`RiskManager: ${error}`);
  } finally { activeTasks--; }
}

// 5. Telegram Bot Reporting
async function runBotService() {
  if (!isStartupComplete) {
    log.info('[BotService] Skipped: Initial data sync not complete yet.');
    return;
  }

  while (activeTasks > 0) {
    log.info(`[BotService] Waiting for ${activeTasks} active services to complete...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  try {
    if (appState.positions.length === 0) {
      log.info('BotService skipped: no active positions');
      return;
    }

    const entries: Array<{ position: PositionRecord; pool: PoolStats; bb: BBResult | null; risk: RiskAnalysis }> = [];
    for (const pos of appState.positions) {
      const poolData = appState.pools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );
      const bb = appState.bbs[poolData?.id.toLowerCase() || ''];
      const risk = pos.riskAnalysis;

      if (!poolData || !risk) {
        log.warn(`Missing data for position ${pos.tokenId}, skipping.`);
        continue;
      }
      entries.push({ position: pos, pool: poolData, bb: bb || null, risk });
    }

    if (entries.length === 0) return;

    await botService.sendConsolidatedReport(entries, appState.pools, appState.lastUpdated);
    log.info(`✅ Telegram report sent  ${entries.length} position(s)`);
  } catch (error) {
    log.error(`BotService: ${error}`);
  }
}

async function main() {
  validateEnv();
  log.section('DexInfoBot startup');

  botService.setPositionScanner(positionScanner);
  botService.setRescheduleCallback(reschedule);
  botService.setUserConfigChangeCallback(async (cfg) => {
    // 在更新前記錄舊錢包清單與已追蹤的 tokenId，用來偵測新增項目
    const prevWalletSet = new Set(ucWalletAddresses(appState.userConfig).map(w => w.toLowerCase()));
    const prevTrackedIds = new Set(ucTrackedPositions(appState.userConfig).map(t => t.tokenId));
    const addedWallets = ucWalletAddresses(cfg).filter(w => !prevWalletSet.has(w.toLowerCase()));
    const addedTracked = ucTrackedPositions(cfg).filter(t => !prevTrackedIds.has(t.tokenId));

    appState.userConfig = cfg;
    // bbKLowVol / bbKHighVol 在 userConfig 更新後同步到 appState runtime 欄位（BBEngine 使用）
    if (cfg.bbKLowVol  !== undefined) appState.bbKLowVol  = cfg.bbKLowVol;
    if (cfg.bbKHighVol !== undefined) appState.bbKHighVol = cfg.bbKHighVol;
    await saveState(
      getPriceBufferSnapshot(),
      bandwidthTracker.snapshot(),
      cfg,
    );
    const wallets = ucWalletAddresses(cfg);
    const tracked = ucTrackedPositions(cfg);
    const investments = cfg.wallets.reduce((s, w) => s + w.positions.filter(p => p.initial > 0).length, 0);
    log.info(`💾 userConfig updated & saved — wallets: ${wallets.length}, investments: ${investments}, tracked: ${tracked.length}`);

    // 有新增錢包或新增 externalStake 倉位 → 背景觸發 chain scan
    if (addedWallets.length > 0 || addedTracked.length > 0) {
      const reason = addedWallets.length > 0
        ? `新錢包: ${addedWallets.join(', ')}`
        : `新追蹤倉位: ${addedTracked.map(t => `#${t.tokenId}`).join(', ')}`;
      log.info(`🔍 ${reason}，背景觸發 chain scan`);
      positionScanner.syncFromChain(true)
        .then(() => saveState(getPriceBufferSnapshot(), bandwidthTracker.snapshot(), appState.userConfig))
        .catch(e => log.error(`Auto sync (new tracked): ${e}`));
    }
  });
  botService.startBot().catch((e) => log.error(`Bot start error: ${e}`));

  const savedState = await loadState();
  if (savedState) {
    restoreState(savedState);
    restorePriceBuffer(savedState.priceBuffer ?? {});
    bandwidthTracker.restore(savedState.bandwidthWindows ?? {});
    // closedTokenIds migration happens in loadState(); restoreFromUserConfig() is called below
    log.info('✅ state restored from previous session');
  }

  // 從 state.json 恢復 userConfig（遷移已在 loadState 處理，包含 sortBy / intervalMinutes / bbK）
  if (savedState?.userConfig) {
    appState.userConfig = savedState.userConfig;
    const uc = appState.userConfig;
    if (uc.intervalMinutes && VALID_INTERVALS.includes(uc.intervalMinutes as IntervalMinutes))
      currentIntervalMinutes = uc.intervalMinutes;
    if (uc.bbKLowVol  !== undefined) appState.bbKLowVol  = uc.bbKLowVol;
    if (uc.bbKHighVol !== undefined) appState.bbKHighVol = uc.bbKHighVol;
    const wallets = ucWalletAddresses(uc);
    const totalPositions = uc.wallets.reduce((s, w) => s + w.positions.length, 0);
    log.info(`✅ userConfig restored — wallets: ${wallets.length}, positions: ${totalPositions}`);
  } else if (savedState) {
    log.info(`userConfig not in state — using .env seed (wallets: ${ucWalletAddresses(appState.userConfig).length})`);
  }

  const hasWallets = ucWalletAddresses(appState.userConfig).length > 0;

  if (!hasWallets) {
    log.warn('No wallet addresses configured — skipping startup scan. Use /wallet add in Telegram to add a wallet.');
  } else {
    positionScanner.restoreFromUserConfig();
    // 從 userConfig.wallets[].positions[] 判斷是否有位置已存在（可跳過 chain scan）
    const allKnownIds = new Set(
      appState.userConfig.wallets.flatMap(w => w.positions.map(p => p.tokenId))
    );
    const savedWalletAddresses = savedState?.userConfig
      ? ucWalletAddresses(savedState.userConfig)
      : (savedState?.syncedWallets ?? []);
    const currentWallets = ucWalletAddresses(appState.userConfig);
    const walletsUnchanged = savedWalletAddresses.length === currentWallets.length &&
      savedWalletAddresses.every(w => currentWallets.includes(w));
    const hasNewTracked = ucTrackedPositions(appState.userConfig).some(
      tp => !allKnownIds.has(tp.tokenId)
    );

    if (walletsUnchanged && allKnownIds.size > 0 && !hasNewTracked) {
      positionScanner.restoreDiscoveredPositions();
    } else {
      if (hasNewTracked) log.info('New tracked positions detected — forcing chain sync');
      await positionScanner.syncFromChain(true);
    }

    await runTokenPriceFetcher();
    await runPoolScanner();

    if (savedState) {
      for (const pool of appState.pools) refreshPriceBuffer(pool.id, pool.tick);
      log.info(`✅ PriceBuffer refreshed for ${appState.pools.length} pool(s) after restore`);
    }

    await runPositionScanner();
    await runBBEngine();
    await runRiskManager();
  }

  isStartupComplete = true;

  const triggerStateSave = async () => saveState(
    getPriceBufferSnapshot(),
    bandwidthTracker.snapshot(),
    appState.userConfig,
  );

  await triggerStateSave();
  // await runBotService().catch((e) => log.error(`Startup report: ${e}`));
  log.info(`startup complete — scheduler enabled (interval: ${currentIntervalMinutes}m)`);
  log.section('ready');

  scheduledTask = buildCronJob();

  // 開始搜尋遺失的時間戳記 (背景執行)
  positionScanner.fillMissingTimestamps(triggerStateSave).catch((e) => log.error(`TimestampFiller: ${e}`));
}

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`${signal} received — saving state before exit`);
  try {
    await saveState(
      getPriceBufferSnapshot(),
      bandwidthTracker.snapshot(),
      appState.userConfig,
    );
    log.info('✅ state saved — exiting');
  } catch (e) {
    log.error(`graceful shutdown save failed: ${e}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main().catch((e) => log.error(`Main error: ${e}`));
