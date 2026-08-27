import { describe, expect, it } from "vitest";

import {
  DEFAULT_UA_CONTROL_CENTER_URL,
  encodeUaControlCenterMenuAction,
  OPEN_UA_CONTROL_CENTER_MENU_ACTION,
  parseUaControlCenterMenuAction,
} from "./uaControlCenter.ts";

describe("uaControlCenter menu action", () => {
  it("encodes and parses the Control Center URL", () => {
    const action = encodeUaControlCenterMenuAction(DEFAULT_UA_CONTROL_CENTER_URL);
    expect(action.startsWith(`${OPEN_UA_CONTROL_CENTER_MENU_ACTION}:`)).toBe(true);
    expect(parseUaControlCenterMenuAction(action)).toBe(DEFAULT_UA_CONTROL_CENTER_URL);
  });

  it("rejects unrelated or empty payloads", () => {
    expect(parseUaControlCenterMenuAction("open-settings")).toBeNull();
    expect(parseUaControlCenterMenuAction(`${OPEN_UA_CONTROL_CENTER_MENU_ACTION}:`)).toBeNull();
    expect(parseUaControlCenterMenuAction(`${OPEN_UA_CONTROL_CENTER_MENU_ACTION}:   `)).toBeNull();
  });
});
