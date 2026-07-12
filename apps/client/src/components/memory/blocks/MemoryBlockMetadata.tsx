import type { MemoryBlockRecord } from "@chvor/shared";
import { Badge } from "@/components/ui/badge";
import { actorText, provenanceText, verifiedText } from "./memory-block-utils";

export function MemoryBlockMetadata({
  record,
  compact = false,
}: {
  record: MemoryBlockRecord;
  compact?: boolean;
}) {
  const { document } = record;
  return (
    <div className="space-y-2 text-[10px] text-muted-foreground">
      <div className="flex flex-wrap gap-1">
        <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
          Layer · {document.layer}
        </Badge>
        <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
          Manager · {document.managedBy}
        </Badge>
        <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
          Revision · {record.revision}
        </Badge>
        <Badge
          variant={document.readOnly ? "secondary" : "outline"}
          className="px-1.5 py-0 text-[9px]"
        >
          Prevent agent changes · {document.readOnly ? "On" : "Off"}
        </Badge>
      </div>
      <dl className={compact ? "grid gap-1" : "grid gap-x-4 gap-y-1 sm:grid-cols-2"}>
        <div>
          <dt className="inline font-medium text-foreground">Confidence: </dt>
          <dd className="inline">{document.confidence}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Verified: </dt>
          <dd className="inline">{verifiedText(document.verifiedAt)}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Actor: </dt>
          <dd className="inline">{actorText(record)}</dd>
        </div>
        {!compact && (
          <div>
            <dt className="inline font-medium text-foreground">Operation: </dt>
            <dd className="inline">{record.operation}</dd>
          </div>
        )}
      </dl>
      <div>
        <p className="mb-1 font-medium text-foreground">Source / provenance</p>
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/20 p-2 font-mono text-[9px]">
          {provenanceText(record)}
        </pre>
      </div>
    </div>
  );
}
