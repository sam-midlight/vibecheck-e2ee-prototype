'use client';

/**
 * ZeroKnowledgeCard — the "Private to you" rail card from the Warm
 * Obsidian mock. A small lock disc + Instrument Serif italic quote
 * reminding the user that the server can't read the room, followed by a
 * one-line Geist body elaborating in plain terms.
 *
 * Pure display; no state. The message is a fixed pair of lines — swap
 * them here if the copy changes.
 */

import { Clay } from './Clay';
import { Icon } from './Icon';
import { Label } from './Label';
import { useDesignMode } from './useDesignMode';

export function ZeroKnowledgeCard() {
  const { t } = useDesignMode();
  return (
    <Clay radius={22} style={{ padding: 18 }}>
      <Label style={{ marginBottom: 8 }}>Zero-knowledge</Label>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            flexShrink: 0,
            background: t.base,
            boxShadow: t.clayInset,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: t.ink,
          }}
        >
          <Icon name="lock" size={13} />
        </div>
        <div
          className="font-display italic"
          style={{
            fontSize: 17,
            color: t.ink,
            lineHeight: 1.25,
          }}
        >
          &ldquo;The server is blind, so the heart can be open.&rdquo;
        </div>
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: t.inkDim,
          marginTop: 10,
          lineHeight: 1.5,
        }}
      >
        Keys live on device. Not even we can read your room.
      </div>
    </Clay>
  );
}
