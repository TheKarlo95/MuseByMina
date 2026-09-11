import type { Metadata, Viewport } from 'next';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Muse by Mina — Plesni studio, Zagreb',
    template: '%s · Muse by Mina',
  },
  description:
    'Plesni studio u Zagrebu. Bachata za odrasle — tradicionalna, moderna i sensual. Dođi na probni sat.',
};

export const viewport: Viewport = {
  // Matches the two theme grounds: plum #420535 and cream #F7F2EE.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#420535' },
    { media: '(prefers-color-scheme: light)', color: '#F7F2EE' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="hr" suppressHydrationWarning>
      <head>
        {/* Before first paint — see src/lib/theme.ts */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link
          rel="preload"
          href="/fonts/cormorant-garamond-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/inter-400-600-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
