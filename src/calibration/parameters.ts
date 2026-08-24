import type { SimConfig } from '../world/state.js';

/**
 * The parameters worth sweeping, and the range each is allowed to move in.
 *
 * Not every knob in `SimConfig` belongs here — some are policy the player sets,
 * some are definitional. These are the ones that shape the economy's dynamics
 * and that a designer would actually reach for.
 */
export interface Parameter {
  key: keyof SimConfig;
  label: string;
  min: number;
  max: number;
  /** Roughly what a meaningful nudge looks like, for search steps. */
  step: number;
}

export const PARAMETERS: Parameter[] = [
  { key: 'priceAdjustment', label: 'Price responsiveness', min: 0.001, max: 0.03, step: 0.002 },
  { key: 'hiringAdjustment', label: 'Hiring responsiveness', min: 0.005, max: 0.08, step: 0.005 },
  { key: 'targetSellThrough', label: 'Target sell-through', min: 0.8, max: 0.99, step: 0.02 },
  { key: 'targetStockDays', label: 'Target stock days', min: 3, max: 20, step: 1 },
  { key: 'demandPriceWeight', label: 'Demand vs stock in pricing', min: 0.2, max: 0.95, step: 0.05 },
  { key: 'targetMarkup', label: 'Target markup over cost', min: 0.03, max: 0.45, step: 0.03 },
  { key: 'costAnchorWeight', label: 'Cost anchor vs trading', min: 0, max: 0.8, step: 0.05 },
  { key: 'firmQualitySpread', label: 'Spread of firm quality', min: 0, max: 0.4, step: 0.03 },
  { key: 'priceElasticity', label: 'Price elasticity of demand', min: 1, max: 6, step: 0.5 },
  { key: 'investmentRate', label: 'Investment rate', min: 0.02, max: 0.35, step: 0.02 },
  { key: 'investmentRateSensitivity', label: 'Investment response to rates', min: 0, max: 15, step: 1 },
  { key: 'savingsBufferDays', label: 'Target savings buffer (days)', min: 30, max: 600, step: 20 },
  { key: 'savingsAdjustment', label: 'Savings adjustment speed', min: 0.001, max: 0.05, step: 0.003 },
  { key: 'savingsRateSensitivity', label: 'Saving response to rates', min: 0, max: 15, step: 1 },
  { key: 'fertilityProsperity', label: 'Births response to prosperity', min: 0, max: 6, step: 0.5 },
  { key: 'prosperityMemory', label: 'How fast the standard of living resets', min: 0.0001, max: 0.01, step: 0.0005 },
  { key: 'incomeSmoothing', label: 'Income smoothing', min: 0.03, max: 0.5, step: 0.03 },
  { key: 'neutralTightness', label: 'Neutral labour tightness', min: 0.85, max: 1.0, step: 0.02 },
  { key: 'wageIndexation', label: 'Wage indexation', min: 0, max: 1, step: 0.1 },
  { key: 'wageTightnessResponse', label: 'Wage response to tightness', min: 0, max: 1.2, step: 0.1 },
  { key: 'maxMonthlyWageCut', label: 'Downward wage flexibility', min: 0, max: 0.02, step: 0.002 },
  { key: 'taylorInflationWeight', label: 'MPC weight on inflation', min: 0.5, max: 2.5, step: 0.15 },
  { key: 'taylorOutputWeight', label: 'MPC weight on output gap', min: 0, max: 1.5, step: 0.1 },
  { key: 'policySmoothing', label: 'MPC inertia', min: 0.5, max: 0.97, step: 0.05 },
  { key: 'neutralRealRate', label: 'Neutral real rate', min: -0.01, max: 0.03, step: 0.005 },
  { key: 'lossGivenDefault', label: 'Loss given default', min: 0.2, max: 0.8, step: 0.05 },
  { key: 'liquidationHaircut', label: 'Liquidation haircut', min: 0.1, max: 0.8, step: 0.05 },
  { key: 'liquidationCyclicality', label: 'Recovery procyclicality', min: 0, max: 6, step: 0.5 },
  { key: 'liquidationVariance', label: 'Recovery variance', min: 0, max: 0.3, step: 0.02 },
  { key: 'workoutHaircutFactor', label: 'Orderly sale advantage', min: 0.1, max: 1, step: 0.1 },
  { key: 'cohortApplicationRate', label: 'Credit demand rate', min: 0.0001, max: 0.003, step: 0.0002 },
];

export function clampToRange(parameter: Parameter, value: number): number {
  return Math.max(parameter.min, Math.min(parameter.max, value));
}

export function baselineValue(config: SimConfig, parameter: Parameter): number {
  return config[parameter.key] as number;
}
