import { describe, expect, it } from "vitest";
import { App } from "../../test/obsidian-stub";
import { PromiseModal } from "./promise-modal";

/** A picker that answers with whatever the test tells it to, and counts closes. */
class Probe extends PromiseModal<string | null> {
	closes = 0;

	protected cancelledValue(): string | null {
		return null;
	}

	close(): void {
		this.closes++;
		super.close();
	}

	commit(value: string): void {
		this.settle(value);
	}

	start(): Promise<string | null> {
		return this.openAndWait();
	}
}

const probe = (): Probe => new Probe(new App() as never);

describe("PromiseModal", () => {
	it("resolves with the committed value, not the cancelled one", async () => {
		const modal = probe();
		const answer = modal.start();
		modal.commit("chosen");
		await expect(answer).resolves.toBe("chosen");
	});

	it("resolves with the cancelled value when the user just closes it", async () => {
		const modal = probe();
		const answer = modal.start();
		modal.close();
		await expect(answer).resolves.toBeNull();
	});

	it("keeps the first answer when settling twice", async () => {
		const modal = probe();
		const answer = modal.start();
		modal.commit("first");
		modal.commit("second");
		await expect(answer).resolves.toBe("first");
	});

	it("does not re-enter close() from onClose()", async () => {
		const modal = probe();
		const answer = modal.start();
		modal.commit("done");
		await expect(answer).resolves.toBe("done");
		// A settle() inside onClose() would close a second time from within
		// the first close's handler.
		expect(modal.closes).toBe(1);
	});
});
