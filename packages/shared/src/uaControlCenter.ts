/** Default Mac hub Control Center UI (Tailscale). Override with T3CODE_UA_CONTROL_CENTER_URL. */
export const DEFAULT_UA_CONTROL_CENTER_URL = "http://100.111.5.64:8765/ui";

/** Desktop application-menu action id (URL is appended after `:`). */
export const OPEN_UA_CONTROL_CENTER_MENU_ACTION = "open-ua-control-center";

export function encodeUaControlCenterMenuAction(url: string): string {
  return `${OPEN_UA_CONTROL_CENTER_MENU_ACTION}:${url}`;
}

export function parseUaControlCenterMenuAction(action: string): string | null {
  const prefix = `${OPEN_UA_CONTROL_CENTER_MENU_ACTION}:`;
  if (!action.startsWith(prefix)) {
    return null;
  }
  const url = action.slice(prefix.length).trim();
  return url.length > 0 ? url : null;
}
