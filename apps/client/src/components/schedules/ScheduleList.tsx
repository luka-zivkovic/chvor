import type { Schedule } from "@chvor/shared";
import { ScheduleCard } from "./ScheduleCard";

interface Props {
  schedules: Schedule[];
}

export function ScheduleList({ schedules }: Props) {
  if (schedules.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/50">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <p className="text-[11px] text-muted-foreground">
          No schedules match this filter.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {schedules.map((s) => (
        <ScheduleCard key={s.id} schedule={s} />
      ))}
    </div>
  );
}
