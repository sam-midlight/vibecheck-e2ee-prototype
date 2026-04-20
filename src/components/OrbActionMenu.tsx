'use client';

import type { MemberMood } from '@/lib/domain/memberMood';

/** Stub during merge — full OrbActionMenu (popover over a tapped
 *  MemberMoodOrb: wave, whisper, request check-in) lands in a later
 *  wave. Accepts the props MemberMoodOrbs passes. */
export function OrbActionMenu(_props: {
  member: MemberMood;
  onClose: () => void;
}): null {
  return null;
}
