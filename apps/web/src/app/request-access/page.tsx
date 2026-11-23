import type { Metadata } from 'next';
import { OutsidePage } from '@/components/access/outside/outside-page';

// Nothing for a search engine: the page shows nothing before sign-in, and its address is for the people who were sent it.
export const metadata: Metadata = { title: 'Ask for access · Landflow', robots: { index: false, follow: false } };

/**
 * /request-access (docs/access-requests.md#the-request-page): where people without a Landflow account ask for access. It sits outside the
 * app shell (listed in PUBLIC_PAGES: no sidebar, no Spotlight), reads nothing on the server and imports none of the admin components;
 * the client loads `/request-access/api/config` and `/session` itself.
 */
export default function RequestAccessPage() {
  return <OutsidePage />;
}
