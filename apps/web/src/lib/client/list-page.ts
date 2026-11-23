/** Rules the list pages share. */

/**
 * A page whose empty state carries its own primary button hides the header's copy of it while it is empty, so the
 * same action is never on screen twice.
 */
export function showHeaderAction(isEmpty: boolean): boolean {
  return !isEmpty;
}
