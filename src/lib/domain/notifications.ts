/**
 * Map a decrypted RoomEvent into a short toast string for the partner.
 *
 * Returns null for events that shouldn't notify — either because they'd be
 * noisy (sliders dragging, love tank adjustments) or because they're
 * administrative (deletes, display-name tweaks, own-event echoes that slip
 * through).
 *
 * Toast copy intentionally keeps it short: emoji + partner name + verb.
 * Details live inside the room; the toast just confirms "something happened"
 * without forcing the reader to scroll.
 */

import type { RoomEvent } from './events';

export interface ToastDescription {
  emoji: string;
  text: string;
}

export function describeEventForToast(
  event: RoomEvent,
  partnerName: string,
  myUserId: string,
): ToastDescription | null {
  switch (event.type) {
    case 'message':
      return { emoji: '💬', text: `${partnerName} sent a message` };
    case 'gratitude_send':
      if (event.to === myUserId) {
        const hearts = '♥'.repeat(Math.min(event.amount, 5));
        return {
          emoji: '🙏',
          text: `${partnerName} sent you ${hearts} (${event.amount})`,
        };
      }
      return null;
    case 'homework_set':
      return {
        emoji: '📝',
        text: event.text.trim().length > 0
          ? `${partnerName} updated the homework`
          : `${partnerName} cleared the homework`,
      };
    case 'icebreaker_post':
      return { emoji: '🛡️', text: `${partnerName} posted in safe space` };
    case 'icebreaker_ready_to_talk':
      return {
        emoji: '🫶',
        text: `${partnerName} is ready to talk about it`,
      };
    case 'icebreaker_resolve':
      return { emoji: '✅', text: `${partnerName} marked it resolved` };
    case 'time_out_start':
      return { emoji: '⏸️', text: `${partnerName} called a time-out` };
    case 'time_out_end':
      return { emoji: '▶️', text: `Time-out ended` };
    case 'date_idea_add':
      return { emoji: '💕', text: `${partnerName} added a date idea: ${event.title}` };
    case 'date_idea_vote':
      return { emoji: '💕', text: `${partnerName} voted on a date` };
    case 'date_idea_schedule':
      return { emoji: '🗓️', text: `${partnerName} scheduled a date` };
    case 'date_idea_complete':
      return { emoji: '✨', text: `${partnerName} wrote their reflection` };
    case 'mind_reader_post':
      return { emoji: '🔮', text: `${partnerName} started a mind reader game` };
    case 'mind_reader_solve':
      return { emoji: '🎉', text: `${partnerName} solved your mind reader!` };
    case 'bribe':
      if (event.targetType === 'mind_reader') {
        return {
          emoji: '🪙',
          text: `${partnerName} bribed ${event.amount}♥ to reveal a mind reader`,
        };
      }
      if (event.targetType === 'date_idea') {
        return {
          emoji: '🚀',
          text: `${partnerName} boosted a date with ${event.amount}♥`,
        };
      }
      return null;
    case 'room_rename':
      return { emoji: '✏️', text: `${partnerName} renamed the room` };
    // Intentionally not toasted (too noisy or trivial):
    case 'slider_set':
    case 'slider_define':
    case 'slider_delete':
    case 'love_tank_set':
    case 'wishlist_add':
    case 'wishlist_claim':
    case 'wishlist_delete':
    case 'date_idea_unvote':
    case 'date_idea_delete':
    case 'mind_reader_delete':
    case 'icebreaker_ack':
    case 'icebreaker_unlock':
    case 'display_name_set':
      return null;
    default:
      return null;
  }
}
