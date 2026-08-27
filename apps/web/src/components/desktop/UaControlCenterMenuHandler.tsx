import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { parseUaControlCenterMenuAction } from "@t3tools/shared/uaControlCenter";
import { useEffect, useMemo } from "react";

import { openUrlInPreview } from "~/browser/openFileInPreview";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

/**
 * Opens the Mac hub Control Center in the existing desktop preview pane when
 * the application menu fires `open-ua-control-center:<url>`.
 *
 * Auth is the hub's `ua_ui` cookie in the shared BrowserSession partition —
 * never an MCP bearer in the renderer.
 */
export function UaControlCenterMenuHandler() {
  const { activeDraftThread, routeThreadRef } = useHandleNewThread();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const threadRef = useMemo(() => {
    if (routeThreadRef) {
      return routeThreadRef;
    }
    if (activeDraftThread) {
      return scopeThreadRef(activeDraftThread.environmentId, activeDraftThread.threadId);
    }
    return null;
  }, [activeDraftThread, routeThreadRef]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      const url = parseUaControlCenterMenuAction(action);
      if (url === null) {
        return;
      }

      if (!isPreviewSupportedInRuntime()) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Control Center needs desktop preview",
            description: "Open T3 Code in the desktop app to embed Unified Agent Control Center.",
          }),
        );
        return;
      }

      if (threadRef === null) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Open a thread first",
            description: "Unified Agent Control Center opens in the active thread's preview pane.",
          }),
        );
        return;
      }

      void openUrlInPreview({
        threadRef,
        url,
        openPreview,
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [openPreview, threadRef]);

  return null;
}
