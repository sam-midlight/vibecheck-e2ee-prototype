import type { Metadata, Viewport } from "next";
import { Geist, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { LavaLamp } from "@/components/design/LavaLamp";
import { TweaksPanel } from "@/components/design/TweaksPanel";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import "./globals.css";

// Body / UI font — Geist, precise humanist sans with a "the server is blind
// and we're serious about it" engineering feel. Set on body via globals.css.
const geist = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Display font — Instrument Serif, warm editorial italic for room names,
// headlines, and any quoted language. Reach for via the `font-display`
// Tailwind utility.
const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
});

// Monospace — JetBrains Mono, used for small-caps data labels ("the
// engineer who understands feelings" texture from the design brief).
const jetbrains = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "VibeCheck 2.0",
  description:
    "A private space for the two of you. End-to-end encrypted, zero-knowledge couples app.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "VibeCheck",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#F2EBDF",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${instrumentSerif.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegister />
        <LavaLamp />
        <TweaksPanel />
        {children}
        <Toaster
          position="top-right"
          duration={4000}
          toastOptions={{
            classNames: {
              toast:
                '!rounded-2xl !border !border-white/60 !bg-white/80 !backdrop-blur-md !shadow-xl !text-sm !text-neutral-900 dark:!bg-neutral-900/80 dark:!border-white/10 dark:!text-neutral-100',
              title: '!font-medium',
              description: '!text-xs !text-neutral-600 dark:!text-neutral-400',
              icon: '!text-base',
            },
          }}
        />
      </body>
    </html>
  );
}
