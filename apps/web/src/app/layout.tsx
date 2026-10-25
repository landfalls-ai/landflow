import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Toaster } from 'sonner';
import { ViewerProvider } from '@/components/auth/viewer';
import { Sidebar } from '@/components/shell/sidebar';
import { themeScript } from '@/components/shell/theme-toggle';
import { pageViewer } from '@/lib/server/auth/pages';
import './globals.css';

export const metadata: Metadata = {
  title: 'Landflow',
  description: 'Low-code workflows with autodiscovered, polyglot node plugins',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Sign-in: the viewer, or a redirect to /login (/setup on a fresh instance) for pages that aren't public.
  const viewer = await pageViewer();
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">
        <ViewerProvider viewer={viewer}>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="relative min-w-0 flex-1">{children}</main>
          </div>
        </ViewerProvider>
        <Toaster
          position="bottom-right"
          toastOptions={{ className: '!bg-sf !border-hair !text-t1 !rounded-xl !shadow-pop !text-[13px]' }}
        />
      </body>
    </html>
  );
}
