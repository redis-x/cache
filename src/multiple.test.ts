import { afterEach, describe, expect, test, vi } from 'vitest';
import { redisClient, redisXClient } from '../test/redis.js';
import {
	createName,
	ENCODINGS,
	type Id,
	multipleGetter,
	readStored,
	TTL,
	writeStored,
} from '../test/utils.js';
import { RedisXCache } from './main.js';

afterEach(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});

/**
 * Creates a `multiple` cache with the `string` encoding.
 * @param name Cache name.
 * @param getter Cache getter.
 * @returns Cache.
 */
function createCache(
	name: string,
	getter: (ids: Id[]) => Promise<Map<Id, string>>,
): RedisXCache<'multiple', 'string', string> {
	return new RedisXCache(
		redisClient,
		{ type: 'multiple', encoding: 'string', name, ttl: TTL },
		getter,
	);
}

describe.each(ENCODINGS)(
	'$encoding encoding',
	({ encoding, value, stored, cached }) => {
		test('computes missing ids, caches each with ttl and returns their stored form', async () => {
			const name = createName();
			const getter = vi.fn(multipleGetter(() => value));
			const cache = new RedisXCache(
				redisClient,
				{ type: 'multiple', encoding, name, ttl: TTL },
				getter,
			);

			expect(await cache.get([1, 'b'])).toStrictEqual(
				new Map<Id, unknown>([
					[1, cached],
					['b', cached],
				]),
			);
			expect(getter).toHaveBeenCalledTimes(1);
			expect(getter).toHaveBeenCalledWith([1, 'b']);
			for (const key of [`@x:cache:${name}:1`, `@x:cache:${name}:b`]) {
				// oxlint-disable-next-line no-await-in-loop
				expect(await readStored(encoding, key)).toStrictEqual(stored);
				// oxlint-disable-next-line no-await-in-loop
				expect(await redisXClient.PTTL(key)).toBeGreaterThan(TTL - 1000);
			}
		});

		test('passes only ids missing from the cache to the getter', async () => {
			const name = createName();
			await writeStored(`@x:cache:${name}:1`, stored);
			const getter = vi.fn(multipleGetter(() => value));
			const cache = new RedisXCache(
				redisClient,
				{ type: 'multiple', encoding, name, ttl: TTL },
				getter,
			);

			expect(await cache.get([1, 2])).toStrictEqual(
				new Map<Id, unknown>([
					[1, cached],
					[2, cached],
				]),
			);
			expect(getter).toHaveBeenCalledTimes(1);
			expect(getter).toHaveBeenCalledWith([2]);
		});

		test('concurrent overlapping gets compute each id once', async () => {
			const options = {
				type: 'multiple',
				encoding,
				name: createName(),
				ttl: TTL,
				retry_interval: 10,
			} as const;
			const getter = vi.fn(multipleGetter(() => value, 50));
			const first = new RedisXCache(redisClient, options, getter);
			const second = new RedisXCache(redisClient, options, getter);

			const results = await Promise.all([
				first.get([1, 2]),
				second.get([2, 3]),
				first.get([1, 3]),
			]);
			const computed_ids = getter.mock.calls.flatMap(([ids]) => ids);
			expect(
				computed_ids.toSorted((a, b) => Number(a) - Number(b)),
			).toStrictEqual([1, 2, 3]);
			expect(results).toStrictEqual([
				new Map<Id, unknown>([
					[1, cached],
					[2, cached],
				]),
				new Map<Id, unknown>([
					[2, cached],
					[3, cached],
				]),
				new Map<Id, unknown>([
					[1, cached],
					[3, cached],
				]),
			]);
		});
	},
);

describe.each(ENCODINGS)(
	'delete() with $encoding encoding',
	({ encoding, value, stored }) => {
		test('removes the given ids without calling the getter', async () => {
			const name = createName();
			await Promise.all([
				writeStored(`@x:cache:${name}:1`, stored),
				writeStored(`@x:cache:${name}:b`, stored),
				writeStored(`@x:cache:${name}:2`, stored),
			]);
			const getter = vi.fn(multipleGetter(() => value));
			const cache = new RedisXCache(
				redisClient,
				{ type: 'multiple', encoding, name, ttl: TTL },
				getter,
			);

			await cache.delete([1, 'b']);
			expect(await readStored(encoding, `@x:cache:${name}:1`)).toBeNull();
			expect(await readStored(encoding, `@x:cache:${name}:b`)).toBeNull();
			expect(await readStored(encoding, `@x:cache:${name}:2`)).toStrictEqual(
				stored,
			);
			expect(getter).not.toHaveBeenCalled();
		});
	},
);

test('delete() with no ids deletes nothing', async () => {
	const name = createName();
	await writeStored(`@x:cache:${name}:1`, 'one');
	const cache = createCache(name, multipleGetter(String));

	await cache.delete([]);
	expect(await readStored('string', `@x:cache:${name}:1`)).toBe('one');
});

test('leaves out and does not cache ids the getter did not return', async () => {
	const name = createName();
	const cache = createCache(name, () => Promise.resolve(new Map([[1, 'one']])));

	expect(await cache.get([1, 404])).toStrictEqual(new Map([[1, 'one']]));
	expect(await readStored('string', `@x:cache:${name}:404`)).toBeNull();
});

test('resolves 1 and "1" as one id', async () => {
	const getter = vi.fn(multipleGetter((id) => `value-${id}`));
	const cache = createCache(createName(), getter);

	expect(await cache.get([1, '1', 2])).toStrictEqual(
		new Map<Id, string>([
			[1, 'value-1'],
			['1', 'value-1'],
			[2, 'value-2'],
		]),
	);
	expect(getter).toHaveBeenCalledWith([1, 2]);
});

test('returns an empty map for no ids without calling the getter', async () => {
	const getter = vi.fn(multipleGetter(String));
	const cache = createCache(createName(), getter);

	expect(await cache.get([])).toStrictEqual(new Map());
	expect(getter).not.toHaveBeenCalled();
});

test('throws a RangeError when more than 100 ids are missing', async () => {
	const getter = vi.fn(multipleGetter(String));
	const cache = createCache(createName(), getter);
	const ids = Array.from({ length: 101 }, (_, index) => index);

	await expect(cache.get(ids)).rejects.toThrow(RangeError);
	expect(getter).not.toHaveBeenCalled();
});

test('get() and delete() need ids and the getter takes them', async () => {
	const cache = new RedisXCache(
		redisClient,
		{ type: 'multiple', encoding: 'string', name: createName(), ttl: TTL },
		// ids are inferred from the type option
		(ids) => Promise.resolve(new Map([[ids[0]!, 'value']])),
	);
	const values: Map<Id, string> = await cache.get([1]);
	expect(values).toStrictEqual(new Map([[1, 'value']]));
	// @ts-expect-error a multiple cache needs ids
	await expect(cache.get()).rejects.toThrow(TypeError);
	// @ts-expect-error a multiple cache needs ids
	await expect(cache.delete()).rejects.toThrow(TypeError);

	expect(
		() =>
			new RedisXCache(
				redisClient,
				{ type: 'multiple', encoding: 'string', name: 'getter', ttl: TTL },
				// @ts-expect-error a multiple cache needs a getter that takes ids and returns a map
				() => Promise.resolve('value'),
			),
	).not.toThrow();
});
