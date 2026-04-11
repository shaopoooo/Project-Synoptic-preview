import type { OpeningStrategy, RegimeVector, PositionRecord, MCSimResult } from '../../types';
import type { OpenAdvice, ExitAdvice, CloseAdvice } from '../../types/positionAdvice';

export function recommendOpen(
  strategy: OpeningStrategy | null,
  regimeVector: RegimeVector,
  poolLabel: string,
): OpenAdvice | null {
  void strategy;
  void regimeVector;
  void poolLabel;
  throw new Error('not implemented — Task 8');
}

export function classifyExit(
  position: PositionRecord,
  currentPriceNorm: number,
  PaNorm: number,
  PbNorm: number,
  atrHalfWidth: number,
  regimeVector: RegimeVector,
): ExitAdvice | null {
  void position;
  void currentPriceNorm;
  void PaNorm;
  void PbNorm;
  void atrHalfWidth;
  void regimeVector;
  throw new Error('not implemented — Task 8');
}

export function shouldClose(
  position: PositionRecord,
  mc: MCSimResult,
  regimeVector: RegimeVector,
  outOfRangeSinceMs: number | null,
  cumulativeIlPct: number | null,
): CloseAdvice | null {
  void position;
  void mc;
  void regimeVector;
  void outOfRangeSinceMs;
  void cumulativeIlPct;
  throw new Error('not implemented — Task 8');
}
