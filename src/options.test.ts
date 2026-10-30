import { RedisXLockerReleaseError } from '@redis-x/locker';
import { afterEach, expect, test, vi } from 'vitest';
import { redisClient, redisXClient } from '../test/redis.js';
import { createName, singleGetter, sleep, TTL } from '../test/utils.js';
import { RedisXCache } from './main.js';

afterEach(async () => {
	await redisXClient.sendCommand('FLUSHDB');
});

test.each([
	{ retry_interval: 10, min: 0, max: 200 },
	{ retry_interval: 300, min: 290, max: 600 },
	{ retry_interval: undefined, min: 490, max: 800 },
])(
	'retry_interval $retry_interval sets the pause before checking the cache again',
	async ({ retry_interval, min, max }) => {
		const name = createName();
		const getter = singleGetter('value', 100);
		const first = new RedisXCache(
			redisClient,
			{ type: 'single', encoding: 'string', name, ttl: TTL },
			getter,
		);
		const second = new RedisXCache(
			redisClient,
			{ type: 'single', encoding: 'string', name, ttl: TTL, retry_interval },
			getter,
		);

		const computing = first.get();
		await sleep(20);
		const started = Date.now();
		expect(await second.get()).toBe('value');
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(min);
		expect(elapsed).toBeLessThan(max);
		await computing;
	},
);

test('lock_ttl lets another instance compute once the lock expires', async () => {
	const name = createName();
	const getter = vi.fn(singleGetter('value', 200));
	const short = new RedisXCache(
		redisClient,
		{ type: 'single', encoding: 'string', name, ttl: TTL, lock_ttl: 50 },
		getter,
	);
	const long = new RedisXCache(
		redisClient,
		{
			type: 'single',
			encoding: 'string',
			name,
			ttl: TTL,
			lock_ttl: 1000,
			retry_interval: 10,
		},
		getter,
	);

	const short_result = short.get();
	await sleep(10);
	const [short_settled, long_settled] = await Promise.allSettled([
		short_result,
		long.get(),
	]);

	expect(getter).toHaveBeenCalledTimes(2);
	expect(long_settled).toStrictEqual({ status: 'fulfilled', value: 'value' });
	// the short lock expired while its getter ran, so releasing it fails
	expect(short_settled).toMatchObject({ status: 'rejected' });
	expect(
		short_settled.status === 'rejected' ? short_settled.reason : undefined,
	).toBeInstanceOf(RedisXLockerReleaseError);
});
