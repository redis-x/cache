import { RedisXClient } from '@redis-x/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { redisClient, redisXClient } from '../test/redis.js';
import {
	createName,
	ENCODINGS,
	readStored,
	singleGetter,
	TTL,
	writeStored,
} from '../test/utils.js';
import { RedisXCache } from './main.js';

afterEach(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});

describe.each(ENCODINGS)(
	'$encoding encoding',
	({ encoding, value, stored, cached }) => {
		test('computes a missing value, caches it with ttl and returns its stored form', async () => {
			const name = createName();
			const getter = vi.fn(singleGetter(value));
			const cache = new RedisXCache(
				redisClient,
				{ type: 'single', encoding, name, ttl: TTL },
				getter,
			);

			expect(await cache.get()).toStrictEqual(cached);
			expect(getter).toHaveBeenCalledTimes(1);
			expect(await readStored(encoding, `@x:cache:${name}`)).toStrictEqual(
				stored,
			);
			expect(await redisXClient.PTTL(`@x:cache:${name}`)).toBeGreaterThan(
				TTL - 1000,
			);
		});

		test('returns a cached value without calling the getter', async () => {
			const name = createName();
			await writeStored(`@x:cache:${name}`, stored);
			const getter = vi.fn(singleGetter(value));
			const cache = new RedisXCache(
				redisClient,
				{ type: 'single', encoding, name, ttl: TTL },
				getter,
			);

			expect(await cache.get()).toStrictEqual(cached);
			expect(getter).not.toHaveBeenCalled();
		});

		test('concurrent gets from two instances call the getter once', async () => {
			const options = {
				type: 'single',
				encoding,
				name: createName(),
				ttl: TTL,
				retry_interval: 10,
			} as const;
			const getter = vi.fn(singleGetter(value, 100));
			const first = new RedisXCache(redisClient, options, getter);
			const second = new RedisXCache(redisClient, options, getter);

			const results = await Promise.all([
				first.get(),
				second.get(),
				first.get(),
				second.get(),
			]);
			expect(getter).toHaveBeenCalledTimes(1);
			expect(results).toStrictEqual([cached, cached, cached, cached]);
		});
	},
);

describe.each(ENCODINGS)(
	'delete() with $encoding encoding',
	({ encoding, value, stored, cached }) => {
		test('removes the cached value without calling the getter', async () => {
			const name = createName();
			await writeStored(`@x:cache:${name}`, stored);
			const getter = vi.fn(singleGetter(value));
			const cache = new RedisXCache(
				redisClient,
				{ type: 'single', encoding, name, ttl: TTL },
				getter,
			);

			await cache.delete();
			expect(await readStored(encoding, `@x:cache:${name}`)).toBeNull();
			expect(getter).not.toHaveBeenCalled();

			expect(await cache.get()).toStrictEqual(cached);
			expect(getter).toHaveBeenCalledTimes(1);
		});
	},
);

test('checks the cache again after getting the lock', async () => {
	const name = createName();
	const client = new RedisXClient(redisClient);
	const mget = client.MGET.bind(client);
	let reads = 0;
	// another instance caches the value between the first read and the lock
	client.MGET = (async (keys: string[]) => {
		const reply = await mget(keys);
		reads++;
		if (reads === 1) {
			await redisXClient.SET(`@x:cache:${name}`, 'cached by another instance');
		}

		return reply;
	}) as typeof client.MGET;
	const getter = vi.fn(singleGetter('computed'));
	const cache = new RedisXCache(
		client,
		{ type: 'single', encoding: 'string', name, ttl: TTL },
		getter,
	);

	expect(await cache.get()).toBe('cached by another instance');
	expect(getter).not.toHaveBeenCalled();
});

test('does not cache a failed getter call and releases the lock', async () => {
	const name = createName();
	const getter = vi
		.fn<() => Promise<string>>()
		.mockRejectedValueOnce(new Error('Getter failed'))
		.mockResolvedValue('value');
	const cache = new RedisXCache(
		redisClient,
		{ type: 'single', encoding: 'string', name, ttl: TTL },
		getter,
	);

	await expect(cache.get()).rejects.toThrow('Getter failed');
	expect(await readStored('string', `@x:cache:${name}`)).toBeNull();
	expect(await cache.get()).toBe('value');
	expect(getter).toHaveBeenCalledTimes(2);
});

test('does not cache an empty hash', async () => {
	const name = createName();
	const getter = vi.fn(singleGetter({}));
	const cache = new RedisXCache(
		redisClient,
		{ type: 'single', encoding: 'hash', name, ttl: TTL },
		getter,
	);

	expect(await cache.get()).toStrictEqual({});
	expect(await readStored('hash', `@x:cache:${name}`)).toBeNull();
	expect(await cache.get()).toStrictEqual({});
	expect(getter).toHaveBeenCalledTimes(2);
});

test('get() and delete() take no ids and the getter takes none', async () => {
	const cache = new RedisXCache(
		redisClient,
		{ type: 'single', encoding: 'hash', name: createName(), ttl: TTL },
		() => Promise.resolve({ age: 30 }),
	);
	const { age }: { age: string } = await cache.get();
	expect(age).toBe('30');
	// @ts-expect-error a single cache takes no ids
	expect(await cache.get([1])).toStrictEqual({ age: '30' });
	// @ts-expect-error a single cache takes no ids
	await cache.delete([1]);

	expect(
		() =>
			new RedisXCache(
				redisClient,
				{ type: 'single', encoding: 'string', name: 'getter', ttl: TTL },
				// @ts-expect-error a single cache needs a getter without ids
				(ids: string[]) => Promise.resolve(new Map([[ids[0]!, 'value']])),
			),
	).not.toThrow();
});
