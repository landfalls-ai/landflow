package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Connection pools are cached per credential: the key is a SHA-256 of the
// database system and every connection setting (password included, so an
// edited credential gets a fresh pool). Pools unused for idleTTL are closed
// by a janitor goroutine, never while a call holds them, and closeAll runs
// on shutdown. The key is a hash, so nothing secret is ever logged with it.

const (
	poolIdleTTL       = 10 * time.Minute
	poolJanitorPeriod = time.Minute
)

type poolEntry struct {
	system   string
	db       *sql.DB
	redis    *redis.Client
	inUse    int
	lastUsed time.Time
}

func (e *poolEntry) close() {
	if e.db != nil {
		_ = e.db.Close()
	}
	if e.redis != nil {
		_ = e.redis.Close()
	}
}

type poolCache struct {
	mu      sync.Mutex
	entries map[string]*poolEntry
	idleTTL time.Duration
	janitor sync.Once
	stop    chan struct{}
}

func newPoolCache(idleTTL time.Duration) *poolCache {
	return &poolCache{entries: map[string]*poolEntry{}, idleTTL: idleTTL, stop: make(chan struct{})}
}

// pools is the process-wide cache used by every node.
var pools = newPoolCache(poolIdleTTL)

// poolKey hashes the system and the connection settings.
func poolKey(system string, settings []string) string {
	h := sha256.New()
	h.Write([]byte(system))
	for _, s := range settings {
		h.Write([]byte{0})
		h.Write([]byte(s))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// acquire returns the cached entry for key, creating it with create on a
// miss. The caller must call the returned release when it is done.
func (c *poolCache) acquire(key string, create func() (*poolEntry, error)) (*poolEntry, func(), error) {
	c.janitor.Do(func() { go c.runJanitor() })
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		var err error
		if e, err = create(); err != nil {
			return nil, nil, err
		}
		c.entries[key] = e
	}
	e.inUse++
	e.lastUsed = time.Now()
	var once sync.Once
	return e, func() {
		once.Do(func() {
			c.mu.Lock()
			e.inUse--
			e.lastUsed = time.Now()
			c.mu.Unlock()
		})
	}, nil
}

// sqlDB returns the pooled *sql.DB of a dialect for one credential.
func (c *poolCache) sqlDB(d *dialect, settings []string, open func() (*sql.DB, error)) (*sql.DB, func(), error) {
	e, release, err := c.acquire(poolKey(d.system, settings), func() (*poolEntry, error) {
		db, err := open()
		if err != nil {
			return nil, err
		}
		return &poolEntry{system: d.system, db: db}, nil
	})
	if err != nil {
		return nil, nil, err
	}
	return e.db, release, nil
}

// redisClient returns the pooled Redis client for one credential.
func (c *poolCache) redisClient(settings []string, open func() *redis.Client) (*redis.Client, func(), error) {
	e, release, err := c.acquire(poolKey(systemRedis, settings), func() (*poolEntry, error) {
		return &poolEntry{system: systemRedis, redis: open()}, nil
	})
	if err != nil {
		return nil, nil, err
	}
	return e.redis, release, nil
}

// stats sums the in-use and idle connections of every pool of a system.
func (c *poolCache) stats(system string) (inUse, idle int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.entries {
		if e.system != system {
			continue
		}
		switch {
		case e.db != nil:
			s := e.db.Stats()
			inUse += s.InUse
			idle += s.Idle
		case e.redis != nil:
			s := e.redis.PoolStats()
			inUse += int(s.TotalConns) - int(s.IdleConns)
			idle += int(s.IdleConns)
		}
	}
	return inUse, idle
}

// evictIdle closes pools nobody holds that were last used before cutoff.
func (c *poolCache) evictIdle(cutoff time.Time) int {
	c.mu.Lock()
	var stale []*poolEntry
	for k, e := range c.entries {
		if e.inUse == 0 && e.lastUsed.Before(cutoff) {
			stale = append(stale, e)
			delete(c.entries, k)
		}
	}
	c.mu.Unlock()
	for _, e := range stale {
		e.close()
	}
	return len(stale)
}

func (c *poolCache) runJanitor() {
	t := time.NewTicker(poolJanitorPeriod)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case now := <-t.C:
			c.evictIdle(now.Add(-c.idleTTL))
		}
	}
}

// closeAll closes every pool (on shutdown, and between tests).
func (c *poolCache) closeAll() {
	c.mu.Lock()
	entries := c.entries
	c.entries = map[string]*poolEntry{}
	c.mu.Unlock()
	for _, e := range entries {
		e.close()
	}
}

// shutdown stops the janitor and closes every pool.
func (c *poolCache) shutdown() {
	select {
	case <-c.stop:
	default:
		close(c.stop)
	}
	c.closeAll()
}

// size reports the number of cached pools.
func (c *poolCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// settingsOf reads credential fields as strings for poolKey.
func settingsOf(get func(string) string, fields ...string) []string {
	out := make([]string, len(fields))
	for i, f := range fields {
		out[i] = f + "=" + get(f)
	}
	return out
}
