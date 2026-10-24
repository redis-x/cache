import { redisXClient } from './redis.js';

export type Id = string | number;

export const TTL = 10_000;

// For each encoding: a getter value, how it is stored in Redis, and how the cache returns it.
export const ENCODINGS = [
	{ encoding: 'string', value: 'value', stored: 'value', cached: 'value' },
	{
		encoding: 'string.json',
		value: { total: 1, tags: ['a'] },
		stored: '{"total":1,"tags":["a"]}',
		cached: { total: 1, tags: ['a'] },
	},
	{
		encoding: 'hash',
		value: { name: 'user', age: 30 },
		stored: { name: 'user', age: '30' },
		cached: { name: 'user', age: '30' },
	},
] as const;

export type Encoding = (typeof ENCODINGS)[number]['encoding'];

let name_index = 0;

/**
 * Creates a cache name that is unique within the test run.
 * @returns Cache name.
 */
export function createName(): string {
	name_index++;
	return `test-${name_index}`;
}

/**
 * Resolves after a given time.
 * @param ms Time in milliseconds.
 * @returns -
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Creates a getter for a `single` cache.
 * @param value Value to return.
 * @param delay Time the getter takes, in milliseconds.
 * @returns Getter.
 */
export function singleGetter<V>(value: V, delay = 0): () => Promise<V> {
	return async () => {
		await sleep(delay);
		return value;
	};
}

/**
 * Creates a getter for a `multiple` cache that returns a value for every ID it receives.
 * @param getValue Returns the value for an ID.
 * @param delay Time the getter takes, in milliseconds.
 * @returns Getter.
 */
export function multipleGetter<V>(
	getValue: (id: Id) => V,
	delay = 0,
): (ids: Id[]) => Promise<Map<Id, V>> {
	return async (ids) => {
		await sleep(delay);
		return new Map(ids.map((id) => [id, getValue(id)]));
	};
}

/**
 * Reads a value as it is stored in Redis.
 * @param encoding Cache encoding.
 * @param key Redis key.
 * @returns Stored value, or `null` if the key does not exist.
 */
export async function readStored(
	encoding: Encoding,
	key: string,
): Promise<string | Record<string, string> | null> {
	if (encoding === 'hash') {
		const hash = await redisXClient.HGETALL(key);
		return Object.keys(hash).length > 0 ? hash : null;
	}

	return redisXClient.GET(key);
}

/**
 * Prepares a cached value directly in Redis.
 * @param key Redis key.
 * @param stored Value as it is stored in Redis.
 */
export async function writeStored(
	key: string,
	stored: string | Readonly<Record<string, string>>,
): Promise<void> {
	await (typeof stored === 'string'
		? redisXClient.SET(key, stored)
		: redisXClient.HSET(key, stored));
}
