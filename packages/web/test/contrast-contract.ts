/**
 * Existing appearance floors, shared by token and rendered consumer proofs.
 * Dark card highlights preserve the pre-retune .064 OKLab step; light's .04
 * holds a visible step above the former .005 without pinning today's .051.
 * The focused orphan floors preserve its former separation in each appearance;
 * the focused step must also remain at least the chip's resting step.
 */
export const cardHighlightFloor = { light: 0.04, dark: 0.064 } as const;
export const focusedOrphanedChipFloor = { light: 0.0403, dark: 0.0602 } as const;
