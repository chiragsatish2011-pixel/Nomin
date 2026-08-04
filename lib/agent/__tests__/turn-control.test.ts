import { describe, expect, it } from "vitest";
import { cancelActiveTurn, registerActiveTurn, unregisterActiveTurn } from "../turn-control";

describe("explicit turn cancellation", () => {
  it("aborts the registered turn exactly once", () => {
    const controller = new AbortController();
    registerActiveTurn("cancel-test", controller);

    expect(cancelActiveTurn("cancel-test")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(cancelActiveTurn("cancel-test")).toBe(false);
  });

  it("does not unregister a newer controller through an old turn's cleanup", () => {
    const oldController = new AbortController();
    const currentController = new AbortController();
    registerActiveTurn("replacement-test", oldController);
    registerActiveTurn("replacement-test", currentController);
    unregisterActiveTurn("replacement-test", oldController);

    expect(oldController.signal.aborted).toBe(true);
    expect(cancelActiveTurn("replacement-test")).toBe(true);
    expect(currentController.signal.aborted).toBe(true);
  });
});
