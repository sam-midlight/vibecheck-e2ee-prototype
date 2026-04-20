'use client';

import Link from 'next/link';
import { AppShell } from '@/components/AppShell';

export default function AboutPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-14 pb-16">
        <Hero />
        <HowToUse />
        <DateLifeCycle />
        <SafeSpaceGuide />
        <PrivacyRefresher />
        <Footer />
      </div>
    </AppShell>
  );
}

function Hero() {
  return (
    <section className="pt-8 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        About VibeCheck
      </p>
      <h1 className="mt-4 font-display italic text-4xl tracking-tight sm:text-5xl">
        A quiet place for the two of you{' '}
        <span className="whitespace-nowrap">to check in.</span>
      </h1>
      <p className="mx-auto mt-5 max-w-xl text-base text-neutral-700 dark:text-neutral-300">
        A short tour of the tools, a gentle guide for the harder conversations,
        and a plain-language look at the privacy promise holding it all up.
      </p>
    </section>
  );
}

function HowToUse() {
  const features: { title: string; body: string }[] = [
    {
      title: 'Vibe sliders',
      body:
        'Wordless check-ins on where each of you is right now. Each slider is tagged with a dimension (Physical, Emotional, Social) and a polarity (high = good or high = bad), so the Oracle can read combinations — not just individual values. Add, rename, or retire sliders; ten "Gold Standard" presets get you started. The control thumb glows in your personal hue, so a partner can tell at a glance whose dot is whose. When a slider drifts into the warning zone, a soft "send a hug / high five / I’m here" support menu appears below it; the floating mark anchors right to the slider that triggered it on your partner’s screen.',
    },
    {
      title: 'Vibe Oracle',
      body:
        'A vector-based empathic narrator. It collapses each member’s slider state into a 3D (Physical, Emotional, Social) vector, classifies the result into one of ten named states (depleted / overwhelmed / tender / cocooning / wired-alone / restless / bright / connected / recharged / steady), and picks a templated line for the situation. "Sam is feeling a surge of anxiety" lands because the math reads frantic + low-energy together, not the slider in isolation. Pure heuristic, runs entirely on your device — no LLM, no data leaves.',
    },
    {
      title: 'Top need · Group needs',
      body:
        'A glanceable "what does my partner need from me right now" card derived from their Love Tank allocation. In rooms with three or more people, individual cards collapse under one "Group needs" section so the sidebar doesn’t grow with party size.',
    },
    {
      title: 'Love tank',
      body:
        'A single 0–100 dial for how full you’re feeling. No guessing, no code-switching — you see theirs, they see yours. Tap your own breathing mood orb above the Vibe Oracle to top up.',
    },
    {
      title: 'Affection layer · heartbeat',
      body:
        'Pick a partner, pick a kiss / hug / high-five, then tap anywhere on the screen to leave it. The mark stays visible to both of you (rotates gently) until the receiver taps it (goes to their bank) or the sender retracts. A separate Heartbeat toggle pulses a soft red edge-vignette on your partner’s screen every 1.6s while you have it on — ephemeral, never persisted, alive-only.',
    },
    {
      title: 'VibeChat',
      body:
        'iMessage-style end-to-end encrypted chat. Bubbles group by sender, the partner’s emoji avatar sits above their name, and every message is signed as it leaves and verified as it arrives — tampered messages surface as errors rather than being quietly trusted.',
    },
    {
      title: 'Intentions',
      body:
        'A shared intention pinned to the Vibe Oracle banner — a sticky note for the week. Either partner can set, edit, or clear it; the latest one is always the active one. Small, steady, visible to both of you.',
    },
    {
      title: 'Rituals',
      body:
        'Morning + evening rituals with completion pips per member, refreshing daily. Pick from suggestions or write your own.',
    },
    {
      title: 'Gratitude',
      body:
        'One to five hearts with a short note, charged by holding the heart down. Send them freely — append-only, no edits, no deletes. Received hearts add to your balance; spend them to boost a date idea or reveal a Mind Reader thought.',
    },
    {
      title: 'Wishlist',
      body:
        'Gift and experience ideas for the two of you. Either person can add; the other can secretly claim one to avoid double-buying. Authors can take down their own entries.',
    },
    {
      title: 'Mind reader',
      body:
        'A lighter way to share something that’s sitting with you: a hint anyone can see, a secret keyword your partner has to guess. A correct guess reveals the full thought to both of you.',
    },
    {
      title: 'Time capsules',
      body:
        'Sealed letters or memories addressed to the future — open dates configurable. They stay sealed even to you until the date arrives.',
    },
    {
      title: 'Action log',
      body:
        'The bottom sidebar widget lists every actionable thing in the room — "4 date ideas to vote on", "Sam’s vault opens in 3 days", "2 mind readers to solve", "Alex has 5 things in their wishlist". Items are derived from state, not view cursors — they only disappear when the underlying thing actually moves (a vote cast, a date arrives, a guess solved).',
    },
    {
      title: 'Live notifications',
      body:
        'When a partner does something notable, an in-app toast shows up with an Open button that deep-links to the relevant feature — the Gratitude sheet for hearts, the Dates sheet for new ideas or votes, the right vault for new wall pins. The "💖 You matched on {title}!" toast fires the moment the final vote lands so neither of you misses the celebration.',
    },
  ];
  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        How to use VibeCheck
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-2xl border border-white/50 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50"
          >
            <h3 className="text-sm font-semibold">{f.title}</h3>
            <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
              {f.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function DateLifeCycle() {
  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        Dates: the full life cycle
      </h2>
      <div className="mt-4 rounded-2xl border border-white/50 bg-white/60 p-6 text-sm text-neutral-700 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50 dark:text-neutral-300">
        <p>
          Dates are the most layered surface in the app — there’s a dedicated
          arc from &ldquo;we should do something&rdquo; to &ldquo;we did it; here’s what we
          remember.&rdquo; Each step is its own small ritual.
        </p>
        <ol className="mt-4 space-y-3 pl-4">
          <li>
            <span className="font-display italic text-neutral-900 dark:text-neutral-50">
              Bank an idea.
            </span>{' '}
            Add free-text on the Dates sheet, or pull the 🎲 generator for a
            randomly-rolled prompt with a twist. In rooms of 3+ you can target
            specific guests instead of the whole room.
          </li>
          <li>
            <span className="font-display italic text-neutral-900 dark:text-neutral-50">
              Vote.
            </span>{' '}
            Each invited member says yes or no. The Vibe Oracle sidebar widget
            also surfaces ideas with a partner’s vote pending and lets you
            quick-vote without opening the sheet.
          </li>
          <li>
            <span className="font-display italic text-neutral-900 dark:text-neutral-50">
              Match.
            </span>{' '}
            Once everyone invited has said yes, the date enters its match
            state. A &ldquo;💖 You matched on {`{title}`}!&rdquo; toast lands on every
            participant’s screen, and the date appears as the hero card on
            the Date Night portal.
          </li>
          <li>
            <span className="font-display italic text-neutral-900 dark:text-neutral-50">
              Schedule + open the vault.
            </span>{' '}
            Pick a time. Tap the hero card to enter the date’s private
            Vault — a pop-up sub-room with its own ambient glow tinted to the
            date’s category (chill = lavender, adventure = ember, etc.).
          </li>
          <li>
            <span className="font-display italic text-neutral-900 dark:text-neutral-50">
              Plan together inside the vault.
            </span>{' '}
            Pin text or photos to the Wall of Intent (post-it style; never
            bleeds into VibeChat). Spin the per-date Decision Roulette to
            settle small frictions (&ldquo;who picks the dessert&rdquo;). Pull a Spark
            prompt — energy-aware, so a chill date gets a deep question and a
            high-energy one gets a silly challenge. The Vibe Preview Dock
            shows everyone’s live (P, E, S) vibe so you check in on
            each other while planning.
          </li>
          <li>
            <span className="font-display italic text-neutral-900 dark:text-neutral-50">
              Capture memories during.
            </span>{' '}
            One-line highlight or photo, posted as a date_memory event. These
            survive the vault locking — they’re the explicit &ldquo;this is one
            we want to keep&rdquo; surface.
          </li>
          <li>
            <span className="font-display italic text-neutral-900 dark:text-neutral-50">
              Mark complete with a comment.
            </span>{' '}
            When the date wraps, hit &ldquo;Mark date as complete&rdquo; and write a
            comment on how it went. Once both of you complete it, the vault
            locks, your comments freeze in place — no edits, ever — and the
            date slides into the Memory Bank.
          </li>
          <li>
            <span className="font-display italic text-neutral-900 dark:text-neutral-50">
              The Memory Bank.
            </span>{' '}
            Below the Date Night portal sits the archive: a masonry of past
            dates. Tap one to open the polaroid view — your frozen &ldquo;How it
            went&rdquo; comments side-by-side, a flippable pile of every wall pin
            from that night, the side-by-side reflection columns, and the
            roulette winners that came out of that date.
          </li>
        </ol>
        <p className="mt-4">
          Each vault has its own unread badge (driven entirely from your
          device), and the Manage Guests panel inside the vault lets the
          creator add or remove people from <em>this date room</em> without
          touching the main room’s membership. Uninvited members see the
          date with a &ldquo;👀 spectating&rdquo; tag and can read along, but can’t
          contribute.
        </p>
      </div>
    </section>
  );
}

function SafeSpaceGuide() {
  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        For the harder conversations
      </h2>
      <div className="mt-4 rounded-2xl border border-white/50 bg-white/60 p-6 text-sm text-neutral-700 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50 dark:text-neutral-300">
        <p>
          <strong className="text-neutral-900 dark:text-neutral-50">
            Safe Space
          </strong>{' '}
          is for the things that feel too heavy for the regular chat. The flow
          is intentional — the friction is the point. It gives both of you a
          little distance from the words, and a little time before you meet each
          other inside them.
        </p>
        <ol className="mt-4 space-y-3 pl-4">
          <li>
            <span className="text-neutral-800 dark:text-neutral-200">
              Write behind a 4-digit code.
            </span>{' '}
            Start from a prompt if one helps, or from scratch. A fresh code is
            attached automatically — only you can see it before you share it.
          </li>
          <li>
            <span className="text-neutral-800 dark:text-neutral-200">
              Say the code out loud, when you&apos;re both ready.
            </span>{' '}
            Not by text. Speaking it is a tiny ritual that says &ldquo;I&apos;m
            ready to receive what&apos;s under here.&rdquo;
          </li>
          <li>
            <span className="text-neutral-800 dark:text-neutral-200">
              Read, sit with it, then tap &ldquo;I&apos;ve read this, let&apos;s
              talk.&rdquo;
            </span>{' '}
            That&apos;s your partner&apos;s cue that you&apos;ve absorbed it and
            you&apos;re ready to discuss — out loud, together.
          </li>
          <li>
            <span className="text-neutral-800 dark:text-neutral-200">
              Mark resolved when the conversation lands.
            </span>{' '}
            Each of you taps it independently; once both have, the entry tucks
            itself into the Resolved archive. Nothing forgotten, nothing
            hovering.
          </li>
        </ol>
        <p className="mt-4">
          If things get heated, either of you can call a{' '}
          <strong className="text-neutral-900 dark:text-neutral-50">
            20-minute time-out
          </strong>
          . Posting and unlocking inside Safe Space pause for everyone in the
          room until the clock runs out. Either partner can end it early (with
          a confirmation) if you&apos;re both ready sooner. From the slider
          warning support menu, an &ldquo;🛡️ I’m here&rdquo; pill drops you straight
          into Safe Space compose mode when a partner needs a heavier surface.
        </p>
      </div>
    </section>
  );
}

function PrivacyRefresher() {
  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        The privacy promise
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Card
          title="Your device holds the keys."
          body="Your encryption keys were generated in your browser on first sign-in and live in your browser&apos;s IndexedDB. The private halves never leave your device in the clear — anything we do see is sealed ciphertext we can&apos;t open."
        />
        <Card
          title="Sealed before it leaves."
          body="Every slider, note, reflection, reaction, message, and date-vault post is encrypted on your device before it&apos;s sent. What lands on our server is random-looking bytes — unreadable without your room key, which we never hold."
        />
        <Card
          title="Zero-knowledge, by design."
          body="We see routing metadata: which user posted to which room, when. No content, no emotions, no moods, no names inside the rooms. Not for us, not for anyone who reaches the server."
        />
      </div>

      <div className="mt-6 rounded-2xl border border-amber-200/60 bg-amber-50/70 p-6 text-sm shadow-lg backdrop-blur-md dark:border-amber-700/50 dark:bg-amber-950/60">
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
          Three layers of safety net
        </h3>
        <p className="mt-2 text-amber-900 dark:text-amber-100">
          Recovery is opt-in and meets you where you are. From settings:
        </p>
        <ul className="mt-3 ml-5 list-disc space-y-1.5 text-amber-900 dark:text-amber-100">
          <li>
            <strong>24-word recovery phrase.</strong> Generated on your
            device (BIP-39), Argon2id-derived key wraps your identity. Only
            the ciphertext reaches our server. The only thing that can bring
            your keys back if you lose every device.
          </li>
          <li>
            <strong>Device passphrase lock.</strong> Wraps your local key
            material in IndexedDB under an Argon2id-derived KEK. Without
            the passphrase, a browser extension or disk forensic tool can’t
            read your keys at rest. Setting it is required after first sign-in.
          </li>
          <li>
            <strong>Per-device revocation.</strong> &ldquo;Your devices&rdquo; in
            settings lists every signed-in device. Revoking one signs a
            cross-signed cert that every other client enforces — the revoked
            device immediately stops being able to read new room messages,
            and every room you admin gets its key rotated to exclude it.
            Cascades into active calls too.
          </li>
        </ul>
        <p className="mt-3 text-amber-900 dark:text-amber-100">
          If you skip recovery, lose every device, and have no other
          signed-in device — your partner can simply re-invite you on a new
          one. You start fresh on the keys; you keep each other.
        </p>
      </div>

      <div className="mt-6 rounded-2xl border border-white/50 bg-white/60 p-6 text-sm shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
        <details>
          <summary className="cursor-pointer font-medium">
            The technical specifics
          </summary>
          <div className="mt-4 space-y-3 text-neutral-700 dark:text-neutral-300">
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong>Identity.</strong> Per-device Ed25519 (signing) and
                X25519 (key exchange) keypairs generated locally on first
                sign-in. A single Master Signing Key + Self-Signing Key +
                User Signing Key sit at the root of the cross-signing chain
                so additional devices can be added or revoked without re-keying
                from scratch. Private halves never leave any device in the
                clear.
              </li>
              <li>
                <strong>Per-room symmetric key.</strong> XChaCha20-Poly1305,
                wrapped individually for each member-device with their X25519
                public key via <code>crypto_box_seal</code>. Only the current
                generation of devices can unwrap it.
              </li>
              <li>
                <strong>Every event is signed.</strong> We verify the sender
                on decrypt — a compromised server can&apos;t forge writes into
                your room, only drop them.
              </li>
              <li>
                <strong>Key rotation on membership change.</strong> Removing a
                member or revoking a device bumps a generation counter and
                re-wraps the room key for everyone remaining. Old blobs stay
                readable to historical members; new writes are unreachable to
                anyone removed.
              </li>
              <li>
                <strong>Device linking.</strong> Adding a second device uses a
                one-time 6-digit approval code. The new device proves it&apos;s
                yours by entering the code on an already-trusted device, which
                then signs an issuance cert and seals the SSK + USK into a
                ciphertext only the new device can open.
              </li>
              <li>
                <strong>Multi-device dedupe.</strong> All your devices appear
                in the room as a single &ldquo;you&rdquo; — the roster, mood orbs, top
                need, gratitude recipients, vote counts, and invitations all
                fold per-device rows into one user-shaped entity.
              </li>
              <li>
                <strong>Web push payload.</strong> Generic by design — &ldquo;💫
                Something new in your room&rdquo; + the roomId for click-through.
                Never any content, even on the OS-level notification.
              </li>
              <li>
                <strong>Optional 24-word recovery phrase.</strong> Off by
                default. If enabled, a BIP-39 phrase is generated on your
                device, an Argon2id key is derived from it, and that key
                encrypts your identity. Only the ciphertext is stored
                server-side — we never see the phrase or the derived key.
              </li>
              <li>
                <strong>Heartbeat broadcasts.</strong> When you have the
                Heartbeat toggle on, your client emits ephemeral broadcast
                pings over the room’s realtime channel addressed to a
                specific recipient. Channel metadata only (&ldquo;user X is
                broadcasting to user Y&rdquo;) — no content, never persisted.
              </li>
            </ul>
            <p className="pt-2 text-xs">
              The whole encryption pipeline runs a live self-test at{' '}
              <Link
                href="/status"
                className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                /status
              </Link>
              . If you&apos;re ever curious whether something is working, that
              page tells you.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-white/50 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p
        className="mt-2 text-sm text-neutral-700 dark:text-neutral-300"
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </div>
  );
}

function Footer() {
  return (
    <section className="text-center text-xs text-neutral-500">
      <p>
        <Link
          href="/rooms"
          className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          back to your rooms
        </Link>
      </p>
    </section>
  );
}
