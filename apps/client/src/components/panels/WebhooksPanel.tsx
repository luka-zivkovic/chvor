import { useEffect, useState } from "react";
import { useFeatureStore } from "../../stores/feature-store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { api } from "../../lib/api";
import type { WebhookSubscription, WebhookEvent, CreateWebhookRequest, WebhookSource } from "@chvor/shared";

type Filter = "all" | "active" | "paused";

function StatBox({ value, label, color }: { value: number; label: string; color?: string }) {
  return (
    <div className="flex-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-center">
      <p className="text-lg font-bold" style={{ color }}>{value}</p>
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}

const SOURCE_LABELS: Record<WebhookSource, { label: string; color: string }> = {
  github: { label: "GitHub", color: "text-green-400" },
  notion: { label: "Notion", color: "text-amber-400" },
  gmail: { label: "Gmail", color: "text-red-400" },
  generic: { label: "Generic", color: "text-cyan-400" },
};

function formatTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function WebhookItem({ webhook, onSelect }: { webhook: WebhookSubscription; onSelect: () => void }) {
  const { updateWebhook } = useFeatureStore();
  const src = SOURCE_LABELS[webhook.source] ?? SOURCE_LABELS.generic;

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const target = !webhook.enabled;
    updateWebhook(webhook.id, { enabled: target });
    try {
      await api.webhooks.toggle(webhook.id, target);
    } catch {
      updateWebhook(webhook.id, { enabled: !target });
    }
  };

  return (
    <Card className="cursor-pointer transition-colors hover:bg-muted/30" onClick={onSelect}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="outline" className={cn("text-[9px]", src.color)}>
              {src.label}
            </Badge>
            <span className="truncate text-sm font-medium">{webhook.name}</span>
          </div>
          <Badge
            variant={webhook.enabled ? "success" : "secondary"}
            className="cursor-pointer shrink-0"
            onClick={handleToggle}
          >
            {webhook.enabled ? "Active" : "Off"}
          </Badge>
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>Last received: {formatTime(webhook.lastReceivedAt)}</span>
          {webhook.deliverTo && webhook.deliverTo.length > 0 && (
            <span>→ {webhook.deliverTo.map((d) => d.channelType).join(", ")}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function WebhookDetail() {
  const { selectedWebhookId, selectWebhook, events, eventsLoading, eventsError, removeWebhook } = useFeatureStore();
  const [webhook, setWebhook] = useState<WebhookSubscription | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedWebhookId) return;
    setDetailLoading(true);
    setDetailError(null);
    api.webhooks
      .get(selectedWebhookId)
      .then(setWebhook)
      .catch((err) => setDetailError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDetailLoading(false));
  }, [selectedWebhookId]);

  if (detailLoading) {
    return <p className="text-xs text-muted-foreground">Loading webhook...</p>;
  }
  if (detailError) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-destructive">{detailError}</p>
        <Button variant="ghost" size="sm" onClick={() => selectWebhook(null)} className="w-fit text-[10px]">
          ← Back to list
        </Button>
      </div>
    );
  }
  if (!webhook) return null;

  const webhookUrl = `${window.location.origin}/api/webhooks/${webhook.id}/receive`;
  const src = SOURCE_LABELS[webhook.source] ?? SOURCE_LABELS.generic;

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.webhooks.delete(webhook.id);
      removeWebhook(webhook.id);
      selectWebhook(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" onClick={() => selectWebhook(null)} className="w-fit text-[10px]">
        ← Back to list
      </Button>

      <div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("text-[9px]", src.color)}>{src.label}</Badge>
          <h2 className="text-base font-semibold">{webhook.name}</h2>
          <Badge variant={webhook.enabled ? "success" : "secondary"}>
            {webhook.enabled ? "Active" : "Off"}
          </Badge>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Webhook URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-[11px] break-all">
                {webhookUrl}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => navigator.clipboard.writeText(webhookUrl)}
                className="text-[10px] shrink-0"
              >
                Copy
              </Button>
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Secret</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-[11px] break-all">
                {showSecret ? webhook.secret : "•".repeat(32)}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowSecret((s) => !s)}
                className="text-[10px] shrink-0"
              >
                {showSecret ? "Hide" : "Show"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => navigator.clipboard.writeText(webhook.secret)}
                className="text-[10px] shrink-0"
              >
                Copy
              </Button>
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Prompt Template</p>
            <pre className="rounded bg-muted p-2 font-mono text-[10px] whitespace-pre-wrap max-h-32 overflow-y-auto">
              {webhook.promptTemplate}
            </pre>
          </div>

          {webhook.filters && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Filters</p>
              <pre className="rounded bg-muted p-2 font-mono text-[10px]">
                {JSON.stringify(webhook.filters, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div>
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          Recent Events
        </h3>
        {eventsLoading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : eventsError ? (
          <p className="text-xs text-destructive">{eventsError}</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No events received yet.</p>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {events.map((ev: WebhookEvent) => (
              <Card key={ev.id}>
                <CardContent className="p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-medium">{ev.eventType}</span>
                    <span className="text-[9px] text-muted-foreground">{formatTime(ev.receivedAt)}</span>
                  </div>
                  {ev.payloadSummary && (
                    <p className="mt-1 text-[10px] text-muted-foreground line-clamp-2">{ev.payloadSummary}</p>
                  )}
                  {ev.result && (
                    <p className="mt-1 text-[10px] text-green-400 line-clamp-2">{ev.result}</p>
                  )}
                  {ev.error && (
                    <p className="mt-1 text-[10px] text-destructive">{ev.error}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Separator />
      {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
      <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
        {deleting ? "Deleting..." : "Delete Subscription"}
      </Button>
    </div>
  );
}

function CreateWebhookDialog({ onClose }: { onClose: () => void }) {
  const { addWebhook } = useFeatureStore();
  const [name, setName] = useState("");
  const [source, setSource] = useState<WebhookSource>("github");
  const [promptTemplate, setPromptTemplate] = useState(
    "A webhook event was received:\n\nEvent: {{event.type}}\nSummary: {{event.summary}}\n\nPlease analyze this event and provide a brief summary."
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const body: CreateWebhookRequest = {
        name: name.trim(),
        source,
        promptTemplate,
      };
      const result = await api.webhooks.create(body);
      addWebhook(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold mb-4">New Webhook Subscription</h2>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Name</label>
            <input
              className="mt-1 w-full rounded border border-input bg-transparent px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="e.g. GitHub PRs - my-repo"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Source</label>
            <select
              className="mt-1 w-full rounded border border-input bg-transparent px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={source}
              onChange={(e) => setSource(e.target.value as WebhookSource)}
            >
              <option value="github">GitHub</option>
              <option value="notion">Notion</option>
              <option value="gmail">Gmail</option>
              <option value="generic">Generic</option>
            </select>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Prompt Template
            </label>
            <textarea
              className="mt-1 w-full rounded border border-input bg-transparent px-3 py-1.5 font-mono text-[11px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              rows={5}
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
            />
            <p className="mt-1 text-[9px] text-muted-foreground">
              Available: {"{{event.type}}"}, {"{{event.summary}}"}, {"{{event.details.*}}"}, {"{{payload}}"}
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleSubmit} disabled={saving || !name.trim()}>
              {saving ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WebhooksPanel() {
  const { fetchWebhooks: fetchAll, webhooksLoading: loading, webhooksError: error, webhooks, selectedWebhookId, selectWebhook } = useFeatureStore();
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    fetchAll();
    return () => { selectWebhook(null); };
  }, [fetchAll, selectWebhook]);

  if (selectedWebhookId) {
    return <WebhookDetail />;
  }

  const filtered = webhooks.filter((w) => {
    if (filter === "active") return w.enabled;
    if (filter === "paused") return !w.enabled;
    return true;
  });

  const activeCount = webhooks.filter((w) => w.enabled).length;
  const pausedCount = webhooks.length - activeCount;

  return (
    <div className="flex flex-col gap-5">
      {webhooks.length > 0 && (
        <div className="flex items-center gap-3">
          <StatBox value={webhooks.length} label="Total" />
          <StatBox value={activeCount} label="Active" color="oklch(0.7 0.18 200)" />
          <StatBox value={pausedCount} label="Paused" />
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(["all", "active", "paused"] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "ghost"}
              size="sm"
              onClick={() => setFilter(f)}
              className={cn("text-[10px] capitalize", filter !== f && "text-muted-foreground")}
            >
              {f}
            </Button>
          ))}
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          + New Webhook
        </Button>
      </div>

      {loading && <p className="text-xs text-muted-foreground">Loading...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {!loading && filtered.length === 0 && (
        <p className="text-center text-xs text-muted-foreground py-8">
          No webhook subscriptions yet. Create one to start receiving events from external services.
        </p>
      )}

      {!loading && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((w) => (
            <WebhookItem key={w.id} webhook={w} onSelect={() => selectWebhook(w.id)} />
          ))}
        </div>
      )}

      {showAdd && <CreateWebhookDialog onClose={() => setShowAdd(false)} />}
    </div>
  );
}
