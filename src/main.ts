import {
	getRedisXClient,
	type RedisXClient,
	stringBulkToObject,
} from '@redis-x/client';
import { RedisXLockerAcquireError, RedisXMultiLocker } from '@redis-x/locker';
import type { JsonArray, JsonObject } from 'type-fest';
import { REDIS_PREFIX, type RedisClient } from './utils.js';

type Id = string | number;
type CacheType = 'single' | 'multiple';
type Encoding = 'string' | 'string.json' | 'hash';
type Value<E extends Encoding> = E extends 'string'
	? string
	: E extends 'string.json'
		? JsonObject | JsonArray
		: E extends 'hash'
			? Record<string, string | number>
			: never;
/** Value as it is stored in Redis: hash fields are read back as strings. */
type Cached<E extends Encoding, V extends Value<E>> = E extends 'hash'
	? { [K in keyof V]: string }
	: V;
type Getter<T extends CacheType, V> = T extends 'multiple'
	? (ids: Id[]) => Promise<Map<Id, V>>
	: () => Promise<V>;
type GetArgs<T extends CacheType> = T extends 'multiple' ? [ids: Id[]] : [];
type GetResult<
	T extends CacheType,
	E extends Encoding,
	V extends Value<E>,
> = T extends 'multiple' ? Map<Id, Cached<E, V>> : Cached<E, V>;
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

/** A cached value: `id` is `undefined` for a single-value cache. */
type Slot = {
	id: Id | undefined;
	key: string;
	lock_id: string;
};

export class RedisXCache<
	T extends CacheType,
	E extends Encoding,
	V extends Value<E>,
> {
	#redisXClient: RedisXClient;
	#options: RedisXCacheOptions<T, E>;
	#getter: Getter<T, V>;
	#locker: RedisXMultiLocker;

	/**
	 * @param redisClient Client from the `redis` package or a RedisX client.
	 * @param options -
	 * @param getter Computes values missing from the cache. For a `multiple` cache, it receives the missing IDs, up to 100 at a time, and IDs missing from the returned map are not cached.
	 */
	constructor(
		redisClient: RedisClient | RedisXClient,
		options: RedisXCacheOptions<T, E>,
		getter: Getter<T, V>,
	) {
		this.#redisXClient = getRedisXClient(redisClient);
		this.#options = options;
		this.#getter = getter;

		this.#locker = new RedisXMultiLocker(
			this.#redisXClient,
			`@x$cache:${options.name}`,
			{
				ttl: options.lock_ttl,
				retry_count: 1,
			},
		);
	}

	#getSlot(id?: Id): Slot {
		let key = `${REDIS_PREFIX}:${this.#options.name}`;
		if (id !== undefined) {
			key += `:${id}`;
		}

		return {
			id,
			key,
			lock_id: id === undefined ? '' : String(id),
		};
	}

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
	async get(...args: GetArgs<T>): Promise<GetResult<T, E, V>> {
		const slots = this.#getSlots(args);

		if (this.#options.type === 'single') {
			const values = await this.#resolve(slots, new Map());

			return values.get(slots[0]!.key) as GetResult<T, E, V>;
		}

		const result = new Map<Id, Cached<E, V>>();
		if (slots.length === 0) {
			return result as GetResult<T, E, V>;
		}

		const [ids] = args as [Id[]];
		const values = await this.#resolve(slots, new Map());
		for (const id of ids) {
			const value = values.get(this.#getSlot(id).key);
			if (value !== undefined) {
				result.set(id, value);
			}
		}

		return result as GetResult<T, E, V>;
	}

	/**
	 * Deletes cached values without computing new ones.
	 *
	 * A `single` cache takes no arguments. A `multiple` cache takes the IDs to delete; `1` and `'1'` are the same ID.
	 * @param args - IDs to delete, for a `multiple` cache.
	 */
	async delete(...args: GetArgs<T>): Promise<void> {
		const slots = this.#getSlots(args);
		if (slots.length > 0) {
			await this.#redisXClient.DEL(slots.map((slot) => slot.key));
		}
	}

	/**
	 * Returns the slots for `get()` or `delete()` arguments, one per Redis key.
	 * @param args - IDs, for a `multiple` cache.
	 * @returns Slots.
	 * @throws {TypeError} If a `multiple` cache gets no IDs.
	 */
	#getSlots(args: GetArgs<T>): Slot[] {
		if (this.#options.type === 'single') {
			return [this.#getSlot()];
		}

		const [ids] = args as [Id[]?];
		if (!Array.isArray(ids)) {
			throw new TypeError('A multiple cache needs IDs.');
		}

		// 1 and '1' share a Redis key, so use each key once
		const keys = new Set<string>();
		const slots: Slot[] = [];
		for (const id of ids) {
			const slot = this.#getSlot(id);
			if (!keys.has(slot.key)) {
				keys.add(slot.key);
				slots.push(slot);
			}
		}

		return slots;
	}

	/**
	 * Reads values from the cache and computes missing ones under a lock, so only one instance computes them at a time.
	 * @param slots Values to resolve.
	 * @param values Resolved values by Redis key, filled by this method.
	 * @returns Resolved values by Redis key.
	 */
	async #resolve(
		slots: Slot[],
		values: Map<string, Cached<E, V>>,
	): Promise<Map<string, Cached<E, V>>> {
		// if every value is in cache, return them
		const missing = await this.#getCachedValues(slots, values);
		if (missing.length === 0) {
			return values;
		}

		// otherwise, compute missing values under a lock
		let lock;
		try {
			lock = await this.#locker.lock(missing.map((slot) => slot.lock_id));
		} catch (error) {
			if (error instanceof RedisXLockerAcquireError) {
				await new Promise((resolve) => {
					setTimeout(resolve, this.#options.retry_interval ?? 500);
				});
				return this.#resolve(missing, values);
			}

			throw error;
		}

		try {
			// another instance may have cached values after the first read, but before we got the lock
			const still_missing = await this.#getCachedValues(missing, values);
			if (still_missing.length > 0) {
				await this.#computeValues(still_missing, values);
			}

			return values;
		} finally {
			await lock.release();
		}
	}

	/**
	 * Runs the getter for missing values, caches them in one batch and adds them to `values`.
	 * @param slots Values to compute.
	 * @param values Resolved values by Redis key.
	 */
	async #computeValues(
		slots: Slot[],
		values: Map<string, Cached<E, V>>,
	): Promise<void> {
		const computed = new Map<string, V>();
		if (this.#options.type === 'single') {
			const value = await (this.#getter as () => Promise<V>)();
			computed.set(slots[0]!.key, value);
		} else {
			const values_by_id = await (
				this.#getter as (ids: Id[]) => Promise<Map<Id, V>>
			)(slots.map((slot) => slot.id!));
			for (const slot of slots) {
				const value = values_by_id.get(slot.id!);
				// IDs the getter didn't return are not cached
				if (value !== undefined) {
					computed.set(slot.key, value);
				}
			}
		}

		const entries: [string, string | Record<string, string>][] = [];
		for (const [key, value] of computed) {
			const encoded = this.#encode(value);
			entries.push([key, encoded]);
			values.set(key, this.#decode(encoded));
		}

		await this.#setCachedValues(entries);
	}

	/**
	 * Converts a value to the form it is stored in Redis.
	 * @param value Value returned by the getter.
	 * @returns Stored value.
	 */
	#encode(value: V): string | Record<string, string> {
		switch (this.#options.encoding) {
			case 'string':
				return value as string;

			case 'string.json':
				return JSON.stringify(value);

			case 'hash':
				return stringBulkToObject(
					Object.entries(value as Record<string, string | number>).flatMap(
						([field, field_value]) => [field, String(field_value)],
					),
				);

			// no default
		}
	}

	/**
	 * Converts a stored value to the value returned from the cache.
	 * @param stored Value as it is stored in Redis.
	 * @returns Cached value.
	 */
	#decode(stored: string | Record<string, string>): Cached<E, V> {
		if (this.#options.encoding === 'string.json') {
			return JSON.parse(stored as string) as Cached<E, V>;
		}

		return stored as Cached<E, V>;
	}

	/**
	 * Reads cached values into `values`.
	 * @param slots Values to read.
	 * @param values Resolved values by Redis key.
	 * @returns Slots that are not in cache.
	 */
	async #getCachedValues(
		slots: Slot[],
		values: Map<string, Cached<E, V>>,
	): Promise<Slot[]> {
		const keys = slots.map((slot) => slot.key);
		const replies =
			this.#options.encoding === 'hash'
				? await Promise.all(keys.map((key) => this.#redisXClient.HGETALL(key)))
				: await this.#redisXClient.MGET(keys);

		const missing: Slot[] = [];
		for (const [index, slot] of slots.entries()) {
			const reply = replies[index];
			// Redis never stores an empty hash, so an empty reply means a missing key
			if (
				reply === null
				|| reply === undefined
				|| (typeof reply === 'object' && Object.keys(reply).length === 0)
			) {
				missing.push(slot);
			} else {
				values.set(slot.key, this.#decode(reply));
			}
		}

		return missing;
	}

	/**
	 * Writes values to the cache in one transaction.
	 * @param entries Redis keys and stored values.
	 */
	async #setCachedValues(
		entries: [string, string | Record<string, string>][],
	): Promise<void> {
		const { ttl } = this.#options;

		await this.#redisXClient
			.createTransaction()
			.use((transaction) => {
				for (const [key, stored] of entries) {
					if (typeof stored === 'string') {
						transaction.SET(key, stored, { PX: ttl });
					} else if (Object.keys(stored).length > 0) {
						// HSET needs at least one field, so an empty hash is not cached
						transaction.HSET(key, stored);
						transaction.PEXPIRE(key, ttl);
					}
				}
			})
			.execute();
	}
}
