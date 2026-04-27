import { useEffect, useRef } from "react";
import { useSessionStore } from "../../stores/session-store";
import { PcConnectionPanel } from "./PcConnectionPanel";

export function PcViewer() {
  const { agents, activeAgentId, latestFrame, latestFrameMime, viewerOpen, setViewerOpen } = useSessionStore();
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    useSessionStore.getState().fetchAgents();
    useSessionStore.getState().fetchConfig();
  }, []);

  useEffect(() => {
    if (!viewerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerOpen, setViewerOpen]);

  if (!viewerOpen) return null;

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative flex w-[90vw] max-w-6xl h-[80vh] rounded-xl border border-white/10 bg-zinc-900 shadow-2xl overflow-hidden">
        {/* Sidebar */}
        <div className="w-64 flex-shrink-0 border-r border-white/10 bg-zinc-900/50 p-4 flex flex-col gap-4 overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/80">PC Control</h2>
            <button
              onClick={() => setViewerOpen(false)}
              className="text-white/40 hover:text-white/80 transition-colors text-lg leading-none"
            >
              &times;
            </button>
          </div>

          <PcConnectionPanel />
        </div>

        {/* Main viewer area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 bg-zinc-900/80">
            {activeAgent ? (
              <>
                <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-sm text-white/70">
                  {activeAgent.hostname}
                </span>
                <span className="text-xs text-white/40">
                  {activeAgent.os} &middot; {activeAgent.screenWidth}&times;{activeAgent.screenHeight}
                </span>
              </>
            ) : (
              <span className="text-sm text-white/40">No PC connected</span>
            )}
          </div>

          {/* Screen view */}
          <div className="flex-1 flex items-center justify-center bg-black/40 p-4 overflow-hidden">
            {latestFrame ? (
              <img
                ref={imgRef}
                src={`data:${latestFrameMime};base64,${latestFrame}`}
                alt="Remote desktop"
                className="max-w-full max-h-full rounded-lg shadow-lg border border-white/5 object-contain"
                draggable={false}
              />
            ) : activeAgent ? (
              <div className="text-white/30 text-sm flex flex-col items-center gap-2">
                <svg className="w-12 h-12 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25h-13.5A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25h-13.5A2.25 2.25 0 0 1 3 12V5.25" />
                </svg>
                <p>Waiting for screenshot...</p>
                <p className="text-xs text-white/20">Ask the AI to take a screenshot or interact with this PC</p>
              </div>
            ) : (
              <div className="text-white/30 text-sm flex flex-col items-center gap-3">
                <svg className="w-16 h-16 text-white/15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25h-13.5A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25h-13.5A2.25 2.25 0 0 1 3 12V5.25" />
                </svg>
                <p>No PC connected</p>
                <p className="text-xs text-white/20 max-w-xs text-center">
                  Install the Chvor PC Agent on a target machine to get started.
                </p>
                <code className="text-[11px] bg-white/5 px-3 py-1.5 rounded-md text-emerald-400/80 font-mono">
                  {`npx @chvor/pc-agent --server ${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/pc-agent`}
                </code>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
