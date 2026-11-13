/**
 * Sign-in for pages (server components): the session from the request's cookie. The root layout calls
 * `pageViewer()`, which sends visitors without a valid session to /login (or /setup before the owner exists);
 * public pages render without one. `requirePageUser(action)` is the same for a page that needs a role.
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { can, type Action, type Viewer } from '../../shared/auth';
import { isPublicPath, PATH_HEADER, SESSION_COOKIE } from '../../shared/auth-paths';
import { ensureBootstrapped } from '../bootstrap';
import { sessionUser } from './sessions';
import { setupRequired, viewerOf, type UserRecord } from './users';

/** The signed-in user of this page request, if any (no redirects). */
export async function currentPageUser(): Promise<UserRecord | undefined> {
  // Not `whenReady()` as routes do: `next build` prerenders pages (/_not-found) in workers where instrumentation
  // registered no bootstrapper, so the page boots through bootstrap.ts itself.
  await ensureBootstrapped();
  return sessionUser((await cookies()).get(SESSION_COOKIE)?.value)?.user;
}

/**
 * The root layout's check: the viewer, or a redirect to /setup or /login for a page that isn't public. The path
 * comes from the proxy (x-landflow-path); without it (no proxy in front) pages render and the API still guards.
 */
export async function pageViewer(): Promise<Viewer | null> {
  const user = await currentPageUser();
  if (user) return viewerOf(user);
  const path = (await headers()).get(PATH_HEADER);
  if (path && !isPublicPath(path.split(/[?#]/)[0])) {
    if (setupRequired()) redirect('/setup');
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return null;
}

/** For a page that needs a signed-in user (and optionally a role): the user, or a redirect. */
export async function requirePageUser(action?: Action): Promise<UserRecord> {
  const user = await currentPageUser();
  if (!user) redirect(setupRequired() ? '/setup' : '/login');
  if (action && !can(user, action)) redirect('/');
  return user;
}
