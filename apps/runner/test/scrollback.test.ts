import { describe, expect, it } from "vitest";
import { Scrollback } from "../src/pty/scrollback";

function expectSizeAccurate(sb: Scrollback): void {
  const text = sb.toString();
  const lines = (text.match(/\n/g) ?? []).length;
  expect(sb.size).toEqual({ chars: text.length, lines });
}

describe("Scrollback", () => {
  it("treats empty appends as no-ops on empty and non-empty buffers", () => {
    const sb = new Scrollback(10, 100);
    sb.append("");
    expect(sb.toString()).toBe("");
    expect(sb.size).toEqual({ chars: 0, lines: 0 });

    sb.append("hello\n");
    sb.append("");
    expect(sb.toString()).toBe("hello\n");
    expectSizeAccurate(sb);
  });

  it("drops whole chunks when remainder stays at or above maxChars, and slices oldest chunk otherwise", () => {
    // Whole-chunk drop: chunks are [5, 5, 5], maxChars = 10 -> dropping chunk 0 leaves 10 (exact limit).
    const exact = new Scrollback(100, 10);
    exact.append("aaaaa");
    exact.append("bbbbb");
    exact.append("ccccc");
    expect(exact.toString()).toBe("bbbbbccccc");
    expectSizeAccurate(exact);

    // Mid-chunk slice: chunks are [6, 6], maxChars = 10 -> dropping chunk 0 would leave 6 (< 10),
    // so chunk 0 is sliced from the front by 2 chars instead of dropped wholesale.
    const sliced = new Scrollback(100, 10);
    sliced.append("012345");
    sliced.append("6789ab");
    expect(sliced.toString()).toBe("23456789ab");
    expectSizeAccurate(sliced);

    // Multiple whole chunks dropped followed by a mid-chunk slice on the next oldest chunk.
    const multi = new Scrollback(100, 7);
    multi.append("1111");
    multi.append("2222");
    multi.append("3333");
    multi.append("4444");
    expect(multi.toString()).toBe("3334444");
    expectSizeAccurate(multi);

    // Single chunk larger than maxChars slices cleanly to its tail.
    const giant = new Scrollback(100, 5);
    giant.append("abcdefghij");
    expect(giant.toString()).toBe("fghij");
    expectSizeAccurate(giant);
  });

  it("drops oldest lines past maxLines for multi-newline chunks and chunks without trailing newlines", () => {
    const sb = new Scrollback(3, 1000);
    sb.append("l1\nl2\nl3"); // 2 newlines, no trailing newline
    expect(sb.size).toEqual({ chars: 8, lines: 2 });

    sb.append("\nl4\nl5"); // +2 newlines -> 4 total, drops "l1\n"
    expect(sb.toString()).toBe("l2\nl3\nl4\nl5");
    expectSizeAccurate(sb);

    // Multi-chunk with multi-newline chunks: drops whole first chunk, then trims inside second.
    const multi = new Scrollback(2, 1000);
    multi.append("a1\na2\n"); // 2 lines
    multi.append("b1\nb2\nb3\n"); // 3 lines
    multi.append("tail"); // 0 lines, no trailing newline
    expect(multi.toString()).toBe("b2\nb3\ntail");
    expectSizeAccurate(multi);

    // maxLines = 0 trims every completed line and preserves only the trailing partial line.
    const zeroLines = new Scrollback(0, 1000);
    zeroLines.append("first\nsecond\npartial");
    expect(zeroLines.toString()).toBe("partial");
    expectSizeAccurate(zeroLines);
  });

  it("handles simultaneous maxChars and maxLines pressure accurately", () => {
    // Case A: maxChars cut removes enough newlines that maxLines is already satisfied.
    const charsFirst = new Scrollback(2, 6);
    charsFirst.append("a\nb\nc\nd"); // 7 chars, 3 newlines -> cutting 1 char removes "a", still 3 newlines -> drops "\n"
    expect(charsFirst.toString()).toBe("b\nc\nd");
    expect(charsFirst.size.chars).toBeLessThanOrEqual(6);
    expect(charsFirst.size.lines).toBeLessThanOrEqual(2);
    expectSizeAccurate(charsFirst);

    // Case B: maxChars cuts past a newline, bringing lines down to maxLines without extra line drops.
    const charsResolvesLines = new Scrollback(2, 4);
    charsResolvesLines.append("12\n3\n4"); // 6 chars, 2 newlines
    charsResolvesLines.append("\n5"); // 8 chars, 3 newlines -> cut 4 chars ("12\n3"), leaving "\n4\n5" (4 chars, 2 newlines)
    expect(charsResolvesLines.toString()).toBe("\n4\n5");
    expectSizeAccurate(charsResolvesLines);

    // Case C: both limits exceeded across multiple chunks; maxChars trims first, then maxLines trims further.
    const both = new Scrollback(2, 10);
    both.append("1\n2\n3\n"); // 6 chars, 3 lines -> trimmed to "2\n3\n" (4 chars, 2 lines)
    expect(both.toString()).toBe("2\n3\n");
    expectSizeAccurate(both);

    both.append("4\n5\n6\n7\n"); // combined 12 chars, 6 lines -> chars trimmed then lines trimmed to 2 lines
    expect(both.toString()).toBe("6\n7\n");
    expect(both.size.chars).toBeLessThanOrEqual(10);
    expect(both.size.lines).toBeLessThanOrEqual(2);
    expectSizeAccurate(both);
  });

  it("keeps size counters accurate across interleaved toString() compactions and appends", () => {
    const sb = new Scrollback(4, 18);
    const inputs = ["alpha\n", "beta", "\ngamma\ndelta\n", "epsilon", "\nzeta\n", "1234567890"];
    for (const chunk of inputs) {
      sb.append(chunk);
      expect(sb.size.chars).toBeLessThanOrEqual(18);
      expect(sb.size.lines).toBeLessThanOrEqual(4);
      expectSizeAccurate(sb);
    }
  });
});
