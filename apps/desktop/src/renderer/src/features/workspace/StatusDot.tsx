import type { ActionRow } from "./types";

export function StatusDot({ status }: { status: ActionRow["status"] }): JSX.Element {
  if (status === "awaiting")
    return <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400" />;
  if (status === "running")
    return <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />;
  if (status === "done") return <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />;
  return <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-500" />;
}
