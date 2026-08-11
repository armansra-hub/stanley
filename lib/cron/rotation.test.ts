import { describe, expect, it } from "vitest";
import { advanceCursorOffset, rotatingWindow, utcDayIndex } from "./rotation";

describe("rotation helpers", () => {
  it("eventually covers every item without duplicates inside a window", () => {
    const items = ["a", "b", "c", "d", "e"];
    const windows = Array.from({ length: 5 }, (_, step) => rotatingWindow(items, step, 2));
    expect(windows.every((window) => new Set(window).size === window.length)).toBe(true);
    expect(new Set(windows.flat())).toEqual(new Set(items));
  });

  it("advances from observed work, wraps at the end, and never skips on an empty failure", () => {
    expect(advanceCursorOffset({ currentOffset: 20, checked: 10, batchSize: 10, done: false })).toBe(30);
    expect(advanceCursorOffset({ currentOffset: 20, checked: 10, batchSize: 10, done: false, reportedNextOffset: 35 })).toBe(35);
    expect(advanceCursorOffset({ currentOffset: 20, checked: 4, batchSize: 10, done: false })).toBe(24);
    expect(advanceCursorOffset({ currentOffset: 20, checked: 10, batchSize: 10, done: true })).toBe(0);
    expect(advanceCursorOffset({ currentOffset: 20, checked: 0, batchSize: 10, done: false })).toBe(20);
  });

  it("derives a stable UTC day index", () => {
    expect(utcDayIndex(new Date("1970-01-01T23:59:59.999Z"))).toBe(0);
    expect(utcDayIndex(new Date("1970-01-02T00:00:00.000Z"))).toBe(1);
  });
});
