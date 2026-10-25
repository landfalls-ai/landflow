import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Toaster } from 'sonner';
import { Sidebar } from '@/components/shell/sidebar';
import { themeScript } from '@/components/shell/theme-toggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'Landflow',
  description: 'Low-code workflows with autodiscovered, polyglot node plugins',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="relative min-w-0 flex-1">{children}</main>
        </div>
        <Toaster
          position="bottom-right"
          toastOptions={{ className: '!bg-sf !border-hair !text-t1 !rounded-xl !shadow-pop !text-[13px]' }}
        />
      </body>
    </html>
  );
}
