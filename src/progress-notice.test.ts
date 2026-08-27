import { describe, expect, it } from "vitest";
import { formatElapsed } from "./progress-notice";

describe("formatElapsed", () => {
  it("starts at zero", () => {
    expect(formatElapsed(0)).toBe("0:00");
  });

  it("pads seconds", () => {
    expect(formatElapsed(7_000)).toBe("0:07");
  });

  it("rolls over into minutes", () => {
    expect(formatElapsed(83_000)).toBe("1:23");
  });

  it("adds an hours field only once it is needed", () => {
    expect(formatElapsed(3_599_000)).toBe("59:59");
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });

  it("never shows a negative clock if the system time jumps back", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});
