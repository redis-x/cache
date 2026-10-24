# @redis-x/cache

[![npm version](https://img.shields.io/npm/v/@redis-x/cache.svg)](https://www.npmjs.com/package/@redis-x/cache)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/@redis-x/cache?style=shieldsio&label=npmx.dev)](https://npmx.dev/package/@redis-x/cache)
[![license](https://img.shields.io/npm/l/@redis-x/cache.svg?color=blue)](https://github.com/redis-x/cache/blob/main/LICENSE)

Redis cache that computes each missing value once, guarded by a distributed lock.

## Features

- ⚡ **Read-Through**: Returns cached values right away and computes missing ones with your getter
- 🔒 **One Computation at a Time**: A distributed lock lets only one instance run the getter for a value
- 📦 **Batches**: Get many values by ID in one call; the getter receives only the missing IDs
- 🗂️ **Encodings**: Store values as strings, JSON or Redis hashes
- ⏱️ **TTL**: Cached values expire on their own
- 🔍 **Type Safety**: Written in TypeScript with full type definitions

## Installation

```bash
bun i @redis-x/cache redis
# or with pnpm
pnpm add @redis-x/cache redis
# or with npm
npm install @redis-x/cache redis
```

**Requirements**:

- Node.js 16.8 or newer;
- `redis@^4.6`;
- (optional) [`@redis-x/client`](https://github.com/redis-x/client);
- Redis server **7.4** or newer.

## Usage

### Caching a Single Value

Use a `single` cache for one value, like statistics from an expensive database query:

```typescript
import { RedisXCache } from '@redis-x/cache';
import { createClient } from 'redis';

const redisClient = createClient();
await redisClient.connect();

const stats = new RedisXCache(
  redisClient,
  {
    type: 'single',
    encoding: 'string.json',
    name: 'stats',
    ttl: 60_000, // Keep the value for 1 minute
  },
  // Runs only when the value is not cached
  async () => await db.queryStats(),
);

const value = await stats.get();
```

Caches accept either a plain `redis` client or a `RedisXClient` from [`@redis-x/client`](https://github.com/redis-x/client) package. If you already use `RedisXClient` in your project, pass it to the constructor to avoid duplicating `RedisXClient` instances.

### Caching Values by ID

Use a `multiple` cache for values that have IDs, like users. Its getter receives only the IDs missing from the cache and returns a `Map` from ID to value:

```typescript
const users = new RedisXCache(
  redisClient,
  {
    type: 'multiple',
    encoding: 'hash',
    name: 'users',
    ttl: 3_600_000, // Keep each user for 1 hour
  },
  async (ids) => await db.loadUsers(ids), // Map<id, user>
);

const found = await users.get([1, 2, 3]); // Map<string | number, user>
```

IDs missing from the getter's `Map` are not cached and are left out of the result. `1` and `'1'` are the same ID.

All missing IDs of one `get()` call are computed under one lock, so up to 100 IDs can be missing from the cache at a time. More throw a `RangeError`.

### Encodings

| Encoding      | Getter returns                     | Stored in Redis as | `get()` returns            |
| ------------- | ---------------------------------- | ------------------ | -------------------------- |
| `string`      | String                             | String             | The string                 |
| `string.json` | JSON object or array               | JSON string        | The parsed JSON            |
| `hash`        | Flat object of strings and numbers | Hash               | The object, fields as strings |

`get()` always returns values as they are stored, even right after the getter computes them. For example, a hash field that the getter returns as `30` always comes back as `'30'`. An empty object is returned but not cached, because Redis can't store an empty hash.

### Options

| Option           | Default | Description                                                                                  |
| ---------------- | ------: | -------------------------------------------------------------------------------------------- |
| `type`           |         | `single` for one value, read with `get()`; `multiple` for values by ID, read with `get(ids)`. |
| `encoding`       |         | How values are stored: `string`, `string.json` or `hash`.                                     |
| `name`           |         | Cache name. Values are stored at `@x:cache:<name>` and `@x:cache:<name>:<id>`.                |
| `ttl`            |         | Lifetime of cached values in milliseconds.                                                    |
| `lock_ttl`       |  `5000` | Lifetime of the lock held while the getter runs, in milliseconds.                             |
| `retry_interval` |   `500` | Milliseconds to wait before checking the cache again while another instance computes values.  |

### How It Works

1. `get()` reads the cache and takes the values it finds.
2. For missing values, it tries to take a lock once.
3. If another instance holds the lock, it waits `retry_interval` and starts over.
4. With the lock, it reads the cache again in case another instance has just written the values. Then it runs the getter for what is still missing, writes the results in one transaction and releases the lock.

So only one instance computes a value at a time, and a cached value is not overwritten by a second computation.

Set `lock_ttl` longer than your getter can take. If the lock expires while the getter runs, another instance can compute the same value, and `get()` throws `RedisLockerReleaseError` when it releases the expired lock.

If the getter throws, nothing is cached and `get()` throws the same error.

### Deleting Values

`delete()` takes the same arguments as `get()` and removes values from the cache without running the getter:

```typescript
await stats.delete();
await users.delete([1, 2]);
```

It doesn't wait for values that another instance is computing at that moment, so such a value can be cached right after the delete.
