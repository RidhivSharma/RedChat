import { randomInt } from 'node:crypto';

// Saturated palette that stays readable on the dark UI.
export const AVATAR_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#ec4899',
];

export function randomAvatarColor() {
  return AVATAR_COLORS[randomInt(AVATAR_COLORS.length)];
}

export default randomAvatarColor;
