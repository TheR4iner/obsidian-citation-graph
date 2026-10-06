import { afterEach, describe, expect, it, vi } from "vitest";

const requestUrl = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	requestUrl: (...args: unknown[]) => requestUrl(...args),
}));

const { SemanticScholarClient } = await import("./semantic-scholar");

describe("SemanticScholarClient rate-limit listeners", () => {
	afterEach(() => {
		vi.useRealTimers();
		requestUrl.mockReset();
	});

	it("keeps one command's listener when an overlapping command unsubscribes", async () => {
		vi.useFakeTimers();
		requestUrl
			.mockRejectedValueOnce({ status: 429 })
			.mockResolvedValueOnce({ json: { paperId: "p1" } });

		const client = new SemanticScholarClient();
		const first: number[] = [];
		const second: number[] = [];
		client.onRateLimitWait((seconds) => first.push(seconds));
		const unsubscribeSecond = client.onRateLimitWait((seconds) => second.push(seconds));
		unsubscribeSecond();

		const lookup = client.getPaper("DOI:10.1/x");
		await vi.runAllTimersAsync();

		await expect(lookup).resolves.toMatchObject({ paperId: "p1" });
		expect(first).toEqual([5]);
		expect(second).toEqual([]);
	});
});
