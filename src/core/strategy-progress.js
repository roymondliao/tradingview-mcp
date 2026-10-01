/** Bounded, optional Strategy automation presentation events. */

export const STRATEGY_AUTOMATION_STAGES = Object.freeze([
  'preflight',
  'acquiring_ownership',
  'initializing_run',
  'resolving_resume',
  'validating_watchlist',
  'synchronizing_strategy',
  'preparing_experiments',
  'executing_experiments',
  'finalizing_run',
]);

const STAGE_SET = new Set(STRATEGY_AUTOMATION_STAGES);

/** Notify a presentation callback without allowing it to affect execution. */
export async function emitStrategyAutomationStatus(onStatus, stage) {
  if (typeof onStatus !== 'function') return;
  if (!STAGE_SET.has(stage)) throw new TypeError(`Unknown Strategy automation stage: ${stage}`);
  try {
    await onStatus(Object.freeze({ stage }));
  } catch {
    // Presentation is deliberately isolated from execution correctness.
  }
}
