import { currentPrincipal } from '../auth/guard';

/** Who a person's action in the Notebook tab is by: their name, else their email. */
export const personOf = () => {
  const user = currentPrincipal()?.user;
  return user?.name || user?.email || 'A person';
};
