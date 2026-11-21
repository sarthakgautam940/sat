import { describe, expect, it } from "vitest";
import { byCode, findQuestion, fullLabel, label, subs } from "./bank";

describe("question labels", () => {
  it("numbers a pattern's first question with the pattern number, never 'a'", () => {
    for (const s of subs) {
      const first = byCode.get((s.section === "math" ? "m" : "r") + s.n + "a")!;
      expect(first.id).toBe(s.qs[0]);
      expect(label(first)).toBe(String(s.n));
    }
    expect(label(byCode.get("m1b")!)).toBe("1b");
    expect(fullLabel(byCode.get("r1a")!)).toBe("R1");
  });

  it("finds questions from what someone types", () => {
    expect(findQuestion("1")!.code).toBe("M1a");
    expect(findQuestion("4")!.code).toBe("M4a");
    expect(findQuestion("r15")!.code).toBe("R15a");
    expect(findQuestion("5b")!.code).toBe("M5b");
    expect(findQuestion("M5c")!.code).toBe("M5c");
    expect(findQuestion("1a")!.code).toBe("M1a");
    expect(findQuestion("99")).toBeUndefined();
  });
});
