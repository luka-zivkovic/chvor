import { useState, memo } from "react";

interface Props {
  text: string;
}

export const HubInfoTooltip = memo(function HubInfoTooltip({ text }: Props) {
  const [show, setShow] = useState(false);

  return (
    <div
      className="absolute -top-1 -right-1 z-10"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <button
        className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white/10 bg-black/40 text-[7px] font-bold text-white/40 backdrop-blur-sm transition-all hover:border-white/25 hover:text-white/70"
        onClick={(e) => { e.stopPropagation(); setShow((s) => !s); }}
      >
        i
      </button>
      {show && (
        <div
          className="absolute top-5 left-1/2 -translate-x-1/2 w-48 rounded-md border border-white/10 bg-black/80 px-2.5 py-1.5 text-[9px] leading-relaxed text-white/70 shadow-lg backdrop-blur-md"
          style={{ pointerEvents: "none" }}
        >
          {text}
        </div>
      )}
    </div>
  );
});
