'use client';

/** Stub during merge — full MemberVibePopover (read-only "check in on
 *  them" view: their sliders, love-tank needs, date prefs, mind-read
 *  guesses) lands in a later wave. */
export type MemberVibeTarget =
  | 'wishlist'
  | 'dates'
  | 'mind_reader'
  | 'time_capsules';

export function MemberVibePopover(_props: {
  uid: string;
  onNavigate?: (target: MemberVibeTarget) => void;
}): null {
  return null;
}
