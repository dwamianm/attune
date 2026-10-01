/**
 * Toast for short confirmations after an action ("Reminder sent to Harbor
 * Coffee Co."). Clears itself after 3 s so it never piles up. On desktop it
 * sits under the header; on phones, where the header wraps onto two lines and
 * the toast covered the command bar, it sits just above the dock instead.
 */
import { CircleCheck } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { useEngine } from "../engine/store.ts";

const NOTICE_MS = 3000;

export function Notice() {
  const notice = useEngine((s) => s.notice);
  const clearNotice = useEngine((s) => s.clearNotice);
  const reduceMotion = useReducedMotion() ?? false;
  const noticeId = notice?.id ?? null;

  useEffect(() => {
    if (noticeId === null) return;
    const t = setTimeout(clearNotice, NOTICE_MS);
    return () => clearTimeout(t);
  }, [noticeId, clearNotice]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--fl-dock-h,52px)+1.25rem)] z-40 flex justify-center px-4 sm:top-16 sm:bottom-auto"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence>
        {notice ? (
          <motion.div
            key={notice.id}
            initial={reduceMotion ? false : { opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -8, transition: { duration: 0.18 } }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 text-sm text-ink shadow-pop"
          >
            <CircleCheck className="size-4 shrink-0 text-good" aria-hidden />
            <span className="min-w-0 truncate">{notice.text}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
