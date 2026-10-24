import { RedisXClient } from "@redis-x/client";
import { RedisClientType, RedisFunctions, RedisModules, RedisScripts } from "redis";
/**
Matches a JSON object.

This type can be useful to enforce some input to be JSON-compatible or as a super-type to be extended from. Don't use this as a direct return type as the user would have to double-cast it: `jsonObject as unknown as CustomResponse`. Instead, you could extend your CustomResponse type from it to ensure your type only uses JSON-compatible types: `interface CustomResponse extends JsonObject { … }`.

@category JSON
*/
type JsonObject = { [Key in string]: JsonValue; };
/**
Matches a JSON array.

@category JSON
*/
type JsonArray = JsonValue[] | readonly JsonValue[];
/**
Matches any valid JSON primitive value.

@category JSON
*/
type JsonPrimitive = string | number | boolean | null;
/**
Matches any valid JSON value.

@see `Jsonify` if you need to transform a type to one that is assignable to `JsonValue`.

@category JSON
*/
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type RedisClient = RedisClientType<RedisModules, RedisFunctions, RedisScripts>;
type Id = string | number;
type CacheType = "single" | "multiple";
type Encoding = "string" | "string.json" | "hash";
type Value<E extends Encoding> = E extends "string" ? string : E extends "string.json" ? JsonObject | JsonArray : E extends "hash" ? Record<string, string | number> : never;
/** Value as it is stored in Redis: hash fields are read back as strings. */
type Cached<E extends Encoding, V extends Value<E>> = E extends "hash" ? { [K in keyof V]: string; } : V;
type Getter<T extends CacheType, V> = T extends "multiple" ? (ids: Id[]) => Promise<Map<Id, V>> : () => Promise<V>;
type GetArgs<T extends CacheType> = T extends "multiple" ? [ids: Id[]] : [];
type GetResult<T extends CacheType, E extends Encoding, V extends Value<E>> = T extends "multiple" ? Map<Id, Cached<E, V>> : Cached<E, V>;
export type RedisXCacheOptions<T extends CacheType, E extends Encoding> = {
  /** `single` caches one value, read with `get()`; `multiple` caches values by ID, read with `get(ids)`. */
  type: T;
  /** How values are stored in Redis: `string` as strings, `string.json` as JSON strings, `hash` as hashes. */
  encoding: E;
  name: string;
  /** Time to live of cached values in milliseconds. */
  ttl: number;
  /** Time to live of the lock held while the getter runs, in milliseconds. */
  lock_ttl?: number;
  /** Pause before checking the cache again when another instance holds the lock, in milliseconds. */
  retry_interval?: number;
};
export declare class RedisXCache<T extends CacheType, E extends Encoding, V extends Value<E>> {
  #private;
  /**
   * @param redisClient Client from the `redis` package or a RedisX client.
   * @param options -
   * @param getter Computes values missing from the cache. For a `multiple` cache, it receives the missing IDs, up to 100 at a time, and IDs missing from the returned map are not cached.
   */
  constructor(redisClient: RedisClient | RedisXClient, options: RedisXCacheOptions<T, E>, getter: Getter<T, V>);
  /**
   * Returns cached values, computing missing ones with the getter.
   *
   * A `single` cache takes no arguments and returns its value.
   * A `multiple` cache takes IDs and returns values by ID, leaving out IDs the getter didn't return; `1` and `'1'` are the same ID.
   * Missing values are computed under one lock, which holds up to 100 IDs, so up to 100 unique IDs can be missing from the cache in one call.
   * @param args - IDs to get, for a `multiple` cache.
   * @returns The value for a `single` cache, or values by ID for a `multiple` cache.
   * @throws {RangeError} If more than 100 unique IDs are missing from the cache.
   */
  get(...args: GetArgs<T>): Promise<GetResult<T, E, V>>;
  /**
   * Deletes cached values without computing new ones.
   *
   * A `single` cache takes no arguments. A `multiple` cache takes the IDs to delete; `1` and `'1'` are the same ID.
   * @param args - IDs to delete, for a `multiple` cache.
   */
  delete(...args: GetArgs<T>): Promise<void>;
}
export {};