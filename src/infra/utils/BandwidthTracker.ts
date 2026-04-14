/**
 * BandwidthTracker — rolling 30D bandwidth window per pool
 *
 * 集中管理各池子的 bandwidth 滾動窗口，供 RiskManager.analyzePosition()
 * 取得 avg30DBandwidth 參數。與 state.json 持久化整合：snapshot / restore。
 */
import { config } from '../../config';

class BandwidthTracker {
    private windows: Record<string, number[]> = {};

    /** 新增本次週期的 bandwidth，回傳目前窗口均值（即 avg30DBandwidth）。 */
    update(poolKey: string, currentBandwidth: number): number {
        const k = poolKey.toLowerCase();
        if (!this.windows[k]) this.windows[k] = [];
        this.windows[k].push(currentBandwidth);
        if (this.windows[k].length > config.BANDWIDTH_WINDOW_MAX) {
            this.windows[k].shift();
        }
        const win = this.windows[k];
        return win.reduce((s, v) => s + v, 0) / win.length;
    }

    /**
     * 查詢指定 pool 的目前 30D 帶寬滾動均值，不修改窗口。
     * 供 PoolMarketService 在計算 bbPattern 前讀取上一週期的均值。
     * 窗口不存在或為空時回傳 null。
     */
    getAvg(poolKey: string): number | null {
        const win = this.windows[poolKey.toLowerCase()];
        if (!win || win.length === 0) return null;
        return win.reduce((s, v) => s + v, 0) / win.length;
    }

    snapshot(): Record<string, number[]> {
        return { ...this.windows };
    }

    restore(saved: Record<string, number[]>): void {
        for (const [k, v] of Object.entries(saved)) {
            this.windows[k] = v;
        }
    }
}

export const bandwidthTracker = new BandwidthTracker();
