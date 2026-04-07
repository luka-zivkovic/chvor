import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

interface UploadZoneProps {
  onUpload: (file: File) => void;
  onIngestUrl: (url: string, title?: string) => void;
  uploading: boolean;
}

const ACCEPTED = ".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp";
const ACCEPTED_EXTS = new Set(ACCEPTED.split(","));
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — matches server limit

export function UploadZone({ onUpload, onIngestUrl, uploading }: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [mode, setMode] = useState<"file" | "url">("file");
  const fileRef = useRef<HTMLInputElement>(null);

  const validateAndUpload = useCallback(
    (file: File) => {
      setSizeError(null);
      const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
      if (!ACCEPTED_EXTS.has(ext)) {
        setSizeError(`Unsupported file type: ${ext}`);
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setSizeError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max 20 MB)`);
        return;
      }
      onUpload(file);
    },
    [onUpload],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) validateAndUpload(file);
    },
    [validateAndUpload],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) validateAndUpload(file);
      e.target.value = "";
    },
    [validateAndUpload],
  );

  const handleUrlSubmit = useCallback(() => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setSizeError(null);
    try {
      new URL(trimmed);
    } catch {
      setSizeError("Invalid URL");
      return;
    }
    onIngestUrl(trimmed);
    setUrlInput("");
  }, [urlInput, onIngestUrl]);

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex gap-1 rounded-md border border-border/50 p-0.5">
        <button
          onClick={() => { setMode("file"); setSizeError(null); }}
          className={cn(
            "flex-1 rounded px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] transition-colors",
            mode === "file"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          File
        </button>
        <button
          onClick={() => { setMode("url"); setSizeError(null); }}
          className={cn(
            "flex-1 rounded px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] transition-colors",
            mode === "url"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          URL
        </button>
      </div>

      {mode === "file" ? (
        <div
          role="button"
          tabIndex={0}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 transition-colors",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-border/50 hover:border-primary/50 hover:bg-muted/30",
            uploading && "pointer-events-none opacity-50",
          )}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mb-2 text-muted-foreground"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span className="text-xs text-muted-foreground">
            {uploading ? "Uploading..." : "Drop file or click to upload"}
          </span>
          <span className="mt-1 text-[10px] text-muted-foreground/60">
            PDF, DOCX, TXT, MD, PNG, JPG, WEBP
          </span>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED}
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
            placeholder="https://..."
            disabled={uploading}
            className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-xs placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none"
          />
          <button
            onClick={handleUrlSubmit}
            disabled={uploading || !urlInput.trim()}
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {uploading ? "..." : "Ingest"}
          </button>
        </div>
      )}

      {sizeError && (
        <p className="text-[10px] text-red-400">{sizeError}</p>
      )}
    </div>
  );
}
