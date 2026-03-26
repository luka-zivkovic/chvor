type Status = "success" | "failed" | "untested" | undefined;

const LABELS: Record<NonNullable<Status>, string> = {
  success: "Valid",
  failed: "Invalid",
  untested: "Untested",
};

const STYLES: Record<NonNullable<Status>, string> = {
  success: "bg-green-500/15 text-green-400",
  failed: "bg-red-500/15 text-red-400",
  untested: "bg-muted text-muted-foreground",
};

const DOT_STYLES: Record<NonNullable<Status>, string> = {
  success: "bg-green-400",
  failed: "bg-red-400",
  untested: "bg-muted-foreground",
};

export function StatusBadge({ status }: { status?: Status }) {
  const s = status ?? "untested";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STYLES[s]}`}
    >
      <span className={`h-1 w-1 rounded-full ${DOT_STYLES[s]}`} />
      {LABELS[s]}
    </span>
  );
}
