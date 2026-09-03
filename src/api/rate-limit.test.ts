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
});
