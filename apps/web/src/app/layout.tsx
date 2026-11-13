import { headers } from 'next/headers';
import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Toaster } from 'sonner';
import { ViewerProvider } from '@/components/auth/viewer';
import { ConfirmHost } from '@/components/ui/confirm';
import { Sidebar } from '@/components/shell/sidebar';
import { lookScript } from '@/components/shell/look-toggle';
import { themeScript } from '@/components/shell/theme-toggle';
import { pageViewer } from '@/lib/server/auth/pages';
import './globals.css';

export const metadata: Metadata = {
  title: 'Landflow',
  description: 'Low-code workflows with autodiscovered, polyglot node plugins',
};

// The page runs under a phone's notch and home bar (`viewport-fit=cover`); the tab bar and headers pad by the safe areas.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Sign-in: the viewer, or a redirect to /login (/setup on a fresh instance) for pages that aren't public.
  const viewer = await pageViewer();
  // The proxy's per-request CSP nonce: an inline script without it does not run under the enforced policy.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: lookScript }} />
      </head>
      <body className="min-h-screen">
        <a href="#main" className="sr-only rounded-lg bg-ac2 px-3 py-2 text-[13px] font-semibold text-on-ac focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100]">
          Skip to content
        </a>
        <ViewerProvider viewer={viewer}>
          <div className="flex min-h-screen flex-col md:flex-row">
            <Sidebar />
            <main id="main" tabIndex={-1} className="relative min-w-0 flex-1 outline-none">
              {children}
            </main>
          </div>
        </ViewerProvider>
        <ConfirmHost />
        {/* Clear of the editor's Spotlight panel: it sets --toast-right (desktop) and --toast-bottom (its phone sheet). */}
        <Toaster
          position="bottom-right"
          offset={{ right: 'var(--toast-right, 24px)', bottom: 'var(--toast-bottom, 24px)' }}
          // Above the phone's tab bar (56 px and the home bar), unless Spotlight's sheet set its own.
          mobileOffset={{ bottom: 'var(--toast-bottom, calc(72px + env(safe-area-inset-bottom)))' }}
          toastOptions={{ className: '!bg-sf !border-hair !text-t1 !rounded-xl !shadow-pop !text-[13px]' }}
        />
      </body>
    </html>
  );
}
