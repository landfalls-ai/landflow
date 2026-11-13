/**
 * What the marketplace routes (`handler(marketplaceRoute(fn))`) share. MarketplaceError and FetchError (the reader's 502)
 * are HttpErrors that `handler` answers itself, and service.ts turns the plain Errors of a bad address or path into
 * MarketplaceErrors, so nothing is mapped by hand here any more; the wrapper stays as the one place the routes name.
 */
export function marketplaceRoute<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return fn;
}
