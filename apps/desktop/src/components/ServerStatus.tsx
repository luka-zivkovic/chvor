import { Circle } from "lucide-react";

interface Props {
  running: boolean;
  pid: number | null;
  port: string | null;
}

export default function ServerStatus({ running, pid, port }: Props) {
  return (
    <div className="flex items-center gap-2.5">
      <Circle
        className={`w-3 h-3 ${
          running
            ? "fill-success text-success animate-pulse-ring"
            : "fill-muted-foreground/40 text-muted-foreground/40"
        }`}
      />
      <span className="text-sm font-medium">
        {running ? "Running" : "Stopped"}
      </span>
      {running && port && (
        <span className="text-xs text-muted-foreground font-mono">
          :{port}
        </span>
      )}
      {running && pid && (
        <span className="text-xs text-muted-foreground font-mono">
          PID {pid}
        </span>
      )}
    </div>
  );
}
