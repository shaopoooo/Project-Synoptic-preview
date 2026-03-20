/**
 * Tests for FAST_STARTUP and isCycleRunning guard logic.
 * Tests the state machine in isolation without importing index.ts (avoid heavy side effects).
 */

describe('isCycleRunning guard (cron overlap protection)', () => {
    let isCycleRunning = false;
    const runOrder: string[] = [];

    async function simulateCycle(name: string, workMs = 10): Promise<void> {
        if (isCycleRunning) {
            runOrder.push(`${name}:skipped`);
            return;
        }
        isCycleRunning = true;
        try {
            runOrder.push(`${name}:start`);
            await new Promise(r => setTimeout(r, workMs));
            runOrder.push(`${name}:end`);
        } finally {
            isCycleRunning = false;
        }
    }

    beforeEach(() => {
        isCycleRunning = false;
        runOrder.length = 0;
    });

    it('executes normally when guard is clear', async () => {
        await simulateCycle('first');
        expect(runOrder).toEqual(['first:start', 'first:end']);
        expect(isCycleRunning).toBe(false);
    });

    it('skips when a cycle is already running', async () => {
        isCycleRunning = true;
        await simulateCycle('blocked');
        expect(runOrder).toEqual(['blocked:skipped']);
        // Flag should remain true because we didn't start (outer code manages it)
    });

    it('concurrent calls: only one proceeds, other is skipped', async () => {
        // JS single-threaded: both enter simultaneously; first sets flag before second checks
        await Promise.all([
            simulateCycle('a', 10),
            simulateCycle('b', 10),
        ]);
        const starts = runOrder.filter(r => r.endsWith(':start'));
        const skips  = runOrder.filter(r => r.endsWith(':skipped'));
        expect(starts).toHaveLength(1);
        expect(skips).toHaveLength(1);
    });

    it('guard resets after cycle completes', async () => {
        await simulateCycle('first');
        expect(isCycleRunning).toBe(false);
        await simulateCycle('second');
        expect(runOrder).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('guard resets even if cycle throws', async () => {
        async function cycleThatThrows() {
            if (isCycleRunning) return;
            isCycleRunning = true;
            try {
                throw new Error('simulated failure');
            } finally {
                isCycleRunning = false;
            }
        }
        await expect(cycleThatThrows()).rejects.toThrow('simulated failure');
        expect(isCycleRunning).toBe(false);
    });
});

describe('FAST_STARTUP timeout trigger', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('callback fires after exactly 5 seconds', () => {
        const callback = jest.fn();
        let isCycleRunning = false;

        // Replicate the FAST_STARTUP setTimeout block from index.ts
        setTimeout(() => {
            if (isCycleRunning) return;
            isCycleRunning = true;
            callback();
            isCycleRunning = false;
        }, 5000);

        expect(callback).not.toHaveBeenCalled();
        jest.advanceTimersByTime(4999);
        expect(callback).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('callback is skipped when isCycleRunning=true at trigger time', () => {
        const callback = jest.fn();
        let isCycleRunning = true; // already running

        setTimeout(() => {
            if (isCycleRunning) return;
            isCycleRunning = true;
            callback();
            isCycleRunning = false;
        }, 5000);

        jest.advanceTimersByTime(5000);
        expect(callback).not.toHaveBeenCalled();
    });

    it('two FAST_STARTUP-style timeouts do not overlap', () => {
        const order: string[] = [];
        let isCycleRunning = false;

        function makeTimeout(name: string, delay: number) {
            setTimeout(() => {
                if (isCycleRunning) { order.push(`${name}:skipped`); return; }
                isCycleRunning = true;
                order.push(`${name}:start`);
                // synchronous work
                order.push(`${name}:end`);
                isCycleRunning = false;
            }, delay);
        }

        makeTimeout('a', 5000);
        makeTimeout('b', 5000); // same time — second one sees flag set by first

        jest.advanceTimersByTime(5000);
        expect(order).toContain('a:start');
        expect(order).toContain('a:end');
        // b fires at same tick — in JS, timers at same delay fire in registration order
        // both run synchronously, so b sees isCycleRunning=false (a already reset it)
        // This documents the actual single-threaded behaviour
        expect(order.length).toBe(4); // both run since synchronous
    });
});
