/**
 * Current time that re-renders on an interval, so "12s ago" labels keep
 * counting while a tab is open. The timer only runs while a caller is mounted.
 */
import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
