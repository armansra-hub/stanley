import { after } from "next/server";

/** Keep the framework lifecycle primitive behind a tiny seam for route tests. */
export function scheduleAfter(task: () => Promise<void>): void {
  after(task);
}
