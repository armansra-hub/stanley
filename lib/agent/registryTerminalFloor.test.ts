import { expect, it } from "vitest";
import { sameRegistryStreet, sameRegistryTerminalFloor } from "./registryProfiles";

const address = (addressLine1: string, addressLine2?: string) => ({
  addressLine1, addressLine2, city: "Salt Lake City", state: "UT", countryCode: "US",
});
const physical = address("320 W 200 S", "FL 3");

it("accepts an explicit equivalent floor without changing legacy comparison or source fields", () => {
  const candidate = address("320 W 200 S Third Floor");
  const before = JSON.stringify([physical, candidate]);
  expect(sameRegistryStreet(physical, candidate)).toBe(false);
  expect(sameRegistryTerminalFloor(physical, candidate)).toBe(true);
  expect(JSON.stringify([physical, candidate])).toBe(before);
});

it.each([
  address("320 W 200 S"), address("320 W 200 S", "FL 4"),
  address("320 W 200 S", "Suite 3"), address("200 S 320 W", "FL 3"),
  address("320 W 200 S", "3th Floor"),
])("rejects missing or conflicting address information: %j", candidate => {
  expect(sameRegistryTerminalFloor(physical, candidate)).toBe(false);
});

it.each(["FL3", "Floor3", "3rdFloor", "Bldg2", "Room4"])("rejects a second joined unit in the street: %s", token => {
  expect(sameRegistryTerminalFloor(address(`320 W 200 S ${token}`, "FL 4"),
    address(`320 W 200 S ${token}`, "4th Floor"))).toBe(false);
});
