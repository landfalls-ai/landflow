'use client';
/** A "Sign out" link for the chromeless pages (no sidebar, so no user menu). */
import { signOut } from './viewer';

export function SignOutLink() {
  return (
    <button type="button" onClick={() => void signOut()} className="text-t3 hover:text-ac max-md:min-h-11">
      Sign out
    </button>
  );
}
