import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", label: "Claude", placeholder: "sk-ant-..." },
  { id: "openai", name: "OpenAI", label: "GPT", placeholder: "sk-..." },
  { id: "google-ai", name: "Google AI", label: "Gemini", placeholder: "AIza..." },
] as const;

interface Props {
  onSelect: (provider: string, apiKey: string) => void;
  initialProvider?: string;
}

export default function ProviderSelector({ onSelect, initialProvider }: Props) {
  const [provider, setProvider] = useState(initialProvider || "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const selected = PROVIDERS.find((p) => p.id === provider)!;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (apiKey.trim()) {
      onSelect(provider, apiKey.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 animate-fade-in">
      {/* Provider tabs */}
      <div className="flex gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setProvider(p.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              provider === p.id
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* API key input */}
      <div className="space-y-2">
        <label className="block text-sm text-muted-foreground">
          {selected.name} API Key
        </label>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={selected.placeholder}
            className="w-full px-3 py-2.5 pr-10 rounded-lg bg-input border border-border text-foreground text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40 transition-shadow"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <button
        type="submit"
        disabled={!apiKey.trim()}
        className="w-full px-4 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
      >
        Continue
      </button>
    </form>
  );
}
