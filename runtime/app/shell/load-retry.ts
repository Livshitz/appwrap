/**
 * Auto-retry schedule for a failed loader:'server' main-frame load: 3 s, doubling, capped at 30 s, and
 * BOUNDED — after MAX_AUTO_RETRIES the shell stops on its own (no endless radio wake-ups on a dead server)
 * and waits for the network to come back or the user's Retry tap. Returns null once exhausted.
 */
export const MAX_AUTO_RETRIES = 8;

export function retryDelayMs(attempt: number): number | null {
  if (attempt >= MAX_AUTO_RETRIES) return null;
  return Math.min(3000 * 2 ** attempt, 30_000);
}
