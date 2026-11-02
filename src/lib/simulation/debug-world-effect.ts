export const DEBUG_WORLD_EFFECT_PREFIX = "[DEBUG_WORLD_EFFECT]";

/** A marked, validated causal action may waive narrative authority only in development. */
export function allowsDevelopmentWorldEffect(marked: boolean): boolean {
  return process.env.NODE_ENV !== 'production' && marked;
}

