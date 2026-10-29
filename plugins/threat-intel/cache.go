package main

import (
	"sync"
	"time"
)

// now is the clock of the cache; tests replace it.
var now = time.Now

// maxCacheEntries bounds the cache: when it is full, expired entries go first, then arbitrary ones.
const maxCacheEntries = 10000

// resultCache is IOC Enrich's in-process TTL cache of service answers, so a burst of alerts about the same indicator
// asks each service once. Only answers without an error are kept (a failure or rate limit is retried by the next alert),
// and concurrent lookups of one key share the first one's answer. It lives as long as the plugin process: a restart or
// another replica starts empty.
type resultCache struct {
	mu       sync.Mutex
	entries  map[string]cacheEntry
	inflight map[string]*flight
}

type cacheEntry struct {
	res     serviceResult
	expires time.Time
}

type flight struct {
	done chan struct{}
	res  serviceResult
}

var cache = &resultCache{entries: map[string]cacheEntry{}, inflight: map[string]*flight{}}

func (c *resultCache) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries, c.inflight = map[string]cacheEntry{}, map[string]*flight{}
}

func (c *resultCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// do returns the cached answer for key or runs fetch and caches it for ttl. cached is true when fetch did not run
// for this caller. ttl <= 0 disables the cache for the call.
func (c *resultCache) do(key string, ttl time.Duration, fetch func() serviceResult) (serviceResult, bool) {
	if ttl <= 0 {
		return fetch(), false
	}
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && now().Before(e.expires) {
		c.mu.Unlock()
		return e.res, true
	}
	if f, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		<-f.done
		return f.res, true
	}
	f := &flight{done: make(chan struct{})}
	c.inflight[key] = f
	c.mu.Unlock()

	completed := false
	defer func() {
		c.mu.Lock()
		delete(c.inflight, key)
		if completed && f.res.Error == "" {
			c.store(key, f.res, ttl)
		}
		c.mu.Unlock()
		close(f.done)
	}()
	f.res = fetch()
	completed = true
	return f.res, false
}

// store adds an entry; the caller holds the lock.
func (c *resultCache) store(key string, res serviceResult, ttl time.Duration) {
	if len(c.entries) >= maxCacheEntries {
		t := now()
		for k, e := range c.entries {
			if !t.Before(e.expires) {
				delete(c.entries, k)
			}
		}
		for k := range c.entries {
			if len(c.entries) < maxCacheEntries {
				break
			}
			delete(c.entries, k)
		}
	}
	c.entries[key] = cacheEntry{res: res, expires: now().Add(ttl)}
}
