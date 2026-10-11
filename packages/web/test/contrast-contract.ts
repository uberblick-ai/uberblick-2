/**
 * Appearance floors, shared by token and rendered consumer proofs.
 * Card highlights keep at least a .064 OKLab step in dark and .04 in light.
 * Focused orphan chips must clear their appearance floor and remain at least
 * as distinct as their resting step.
 */
export const cardHighlightFloor = { light: 0.04, dark: 0.064 } as const;
export const focusedOrphanedChipFloor = { light: 0.0403, dark: 0.0602 } as const;
