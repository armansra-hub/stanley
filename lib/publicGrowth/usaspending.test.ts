import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { recipientProfileUrl } from "./usaspending";

describe("USAspending evidence URLs", () => {
  it("uses the frozen recipient hash and verified /latest profile route", () => {
    expect(recipientProfileUrl({
      recipientId: "recipient/hash",
      uei: "UEI-FALLBACK",
      name: "Fallback Company",
    })).toBe("https://www.usaspending.gov/recipient/recipient%2Fhash/latest");
  });
});
