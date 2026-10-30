import { getRedisXClient, stringBulkToObject } from "@redis-x/client";
import { RedisXLockerAcquireError, RedisXMultiLocker } from "@redis-x/locker";
// src/utils.ts
const REDIS_PREFIX = "@x:cache";
// src/main.ts
var RedisXCache = class {
	#redisXClient;
	#options;
	#getter;
	#locker;
	/**
	* @param redisClient Client from the `redis` package or a RedisX client.
	* @param options -
	* @param getter Computes values missing from the cache. For a `multiple` cache, it receives the missing IDs, up to 100 at a time, and IDs missing from the returned map are not cached.
	*/
	constructor(redisClient, options, getter) {
		this.#redisXClient = getRedisXClient(redisClient);
		this.#options = options;
		this.#getter = getter;
		this.#locker = new RedisXMultiLocker(this.#redisXClient, `@x$cache:${options.name}`, {
			ttl: options.lock_ttl,
			retry_count: 1
		});
	}
	#getSlot(id) {
		let key = `${REDIS_PREFIX}:${this.#options.name}`;
		if (id !== void 0) key += `:${id}`;
		return {
			id,
			key,
			lock_id: id === void 0 ? "" : String(id)
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
	async get(...args) {
		const slots = this.#getSlots(args);
		if (this.#options.type === "single") return (await this.#resolve(slots, /* @__PURE__ */ new Map())).get(slots[0].key);
		const result = /* @__PURE__ */ new Map();
		if (slots.length === 0) return result;
		const [ids] = args;
		const values = await this.#resolve(slots, /* @__PURE__ */ new Map());
		for (const id of ids) {
			const value = values.get(this.#getSlot(id).key);
			if (value !== void 0) result.set(id, value);
		}
		return result;
	}
	/**
	* Deletes cached values without computing new ones.
	*
	* A `single` cache takes no arguments. A `multiple` cache takes the IDs to delete; `1` and `'1'` are the same ID.
	* @param args - IDs to delete, for a `multiple` cache.
	*/
	async delete(...args) {
		const slots = this.#getSlots(args);
		if (slots.length > 0) await this.#redisXClient.DEL(slots.map((slot) => slot.key));
	}
	/**
	* Returns the slots for `get()` or `delete()` arguments, one per Redis key.
	* @param args - IDs, for a `multiple` cache.
	* @returns Slots.
	* @throws {TypeError} If a `multiple` cache gets no IDs.
	*/
	#getSlots(args) {
		if (this.#options.type === "single") return [this.#getSlot()];
		const [ids] = args;
		if (!Array.isArray(ids)) throw new TypeError("A multiple cache needs IDs.");
		const keys = /* @__PURE__ */ new Set();
		const slots = [];
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
	async #resolve(slots, values) {
		const missing = await this.#getCachedValues(slots, values);
		if (missing.length === 0) return values;
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
			const still_missing = await this.#getCachedValues(missing, values);
			if (still_missing.length > 0) await this.#computeValues(still_missing, values);
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
	async #computeValues(slots, values) {
		const computed = /* @__PURE__ */ new Map();
		if (this.#options.type === "single") {
			const value = await this.#getter();
			computed.set(slots[0].key, value);
		} else {
			const values_by_id = await this.#getter(slots.map((slot) => slot.id));
			for (const slot of slots) {
				const value = values_by_id.get(slot.id);
				if (value !== void 0) computed.set(slot.key, value);
			}
		}
		const entries = [];
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
	#encode(value) {
		switch (this.#options.encoding) {
			case "string": return value;
			case "string.json": return JSON.stringify(value);
			case "hash": return stringBulkToObject(Object.entries(value).flatMap(([field, field_value]) => [field, String(field_value)]));
		}
	}
	/**
	* Converts a stored value to the value returned from the cache.
	* @param stored Value as it is stored in Redis.
	* @returns Cached value.
	*/
	#decode(stored) {
		if (this.#options.encoding === "string.json") return JSON.parse(stored);
		return stored;
	}
	/**
	* Reads cached values into `values`.
	* @param slots Values to read.
	* @param values Resolved values by Redis key.
	* @returns Slots that are not in cache.
	*/
	async #getCachedValues(slots, values) {
		const keys = slots.map((slot) => slot.key);
		const replies = this.#options.encoding === "hash" ? await Promise.all(keys.map((key) => this.#redisXClient.HGETALL(key))) : await this.#redisXClient.MGET(keys);
		const missing = [];
		for (const [index, slot] of slots.entries()) {
			const reply = replies[index];
			if (reply === null || reply === void 0 || typeof reply === "object" && Object.keys(reply).length === 0) missing.push(slot);
			else values.set(slot.key, this.#decode(reply));
		}
		return missing;
	}
	/**
	* Writes values to the cache in one transaction.
	* @param entries Redis keys and stored values.
	*/
	async #setCachedValues(entries) {
		const { ttl } = this.#options;
		await this.#redisXClient.createTransaction().use((transaction) => {
			for (const [key, stored] of entries) if (typeof stored === "string") transaction.SET(key, stored, { PX: ttl });
			else if (Object.keys(stored).length > 0) {
				transaction.HSET(key, stored);
				transaction.PEXPIRE(key, ttl);
			}
		}).execute();
	}
};
export { RedisXCache };
