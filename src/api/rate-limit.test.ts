import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
	it("runs the first call without waiting", async () => {
		const started = Date.now();
		await new RateLimiter(200).run(async () => "done");
		expect(Date.now() - started).toBeLessThan(150);
	});

	it("spaces a second call by at least the interval", async () => {
		const limiter = new RateLimiter(120);
		const started = Date.now();
		await limiter.run(async () => 1);
		await limiter.run(async () => 2);
		expect(Date.now() - started).toBeGreaterThanOrEqual(110);
	});

	it("passes the result through and does not swallow failures", async () => {
		const limiter = new RateLimiter(0);
		await expect(limiter.run(async () => "value")).resolves.toBe("value");
		await expect(
			limiter.run(async () => {
				throw new Error("upstream");
			})
		).rejects.toThrow("upstream");
	});

	it("spaces concurrent callers instead of releasing them together", async () => {
		// The bug this guards: two callers that arrive inside the interval both
		// read the same timestamp, sleep the same amount, and fire at once.
		const limiter = new RateLimiter(100);
		const starts: number[] = [];
		const mark = async (): Promise<void> => {
			starts.push(Date.now());
		};
		await limiter.run(mark);
		await Promise.all([limiter.run(mark), limiter.run(mark)]);
		expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(90);
		expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(90);
	});

	it("does not make one slow call delay the next one's start", async () => {
		// Slots are claimed in order; a request still in flight must not hold
		// the queue, or every source would serialize end to end.
		const limiter = new RateLimiter(0);
		let secondStarted = false;
		const slow = limiter.run(async () => {
			await sleep(120);
			return "slow";
		});
		const quick = limiter.run(async () => {
			secondStarted = true;
			return "quick";
		});
		await quick;
		expect(secondStarted).toBe(true);
		await expect(slow).resolves.toBe("slow");
	});
});
