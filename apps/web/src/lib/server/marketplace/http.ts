/** Error mapping shared by the marketplace routes. */
import { error } from '../http';
import { FetchError } from './reader';
import { MarketplaceError } from './service';

/** MarketplaceError → its status; failures talking to GitHub or a URL → 502. */
export function marketplaceRoute<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (caught) {
      if (caught instanceof MarketplaceError) return error(caught.message, caught.status, caught.body);
      if (caught instanceof FetchError) return error(caught.message, 502);
      if (caught instanceof Error && /^(Enter a GitHub|Only http|A local marketplace|Path contains)/.test(caught.message)) return error(caught.message, 400);
      throw caught;
    }
  };
}
