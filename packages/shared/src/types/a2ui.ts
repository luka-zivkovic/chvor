/* ─── A2UI Protocol Types (v0.9) ─── */

// ── Value types ──

export interface A2UILiteralString {
  literalString: string;
}

export interface A2UIBoundValue {
  binding: string;
}

export type A2UITextValue = A2UILiteralString | A2UIBoundValue;

export interface A2UIChildList {
  explicitList: string[];
}

// ── Component definitions ──

export interface A2UITextComponent {
  Text: {
    text: A2UITextValue;
    usageHint?: "h1" | "h2" | "h3" | "body" | "caption" | "code";
  };
}

export interface A2UIColumnComponent {
  Column: {
    children: A2UIChildList;
    gap?: number;
    align?: "start" | "center" | "end";
  };
}

export interface A2UIRowComponent {
  Row: {
    children: A2UIChildList;
    gap?: number;
    align?: "start" | "center" | "end";
  };
}

export interface A2UIImageComponent {
  Image: {
    src: A2UITextValue;
    alt?: string;
    width?: number;
    height?: number;
  };
}

export interface A2UITableComponent {
  Table: {
    columns: { key: string; label: string }[];
    rows: A2UITextValue;
    emptyText?: string;
  };
}

export interface A2UIButtonComponent {
  Button: {
    label: A2UITextValue;
    action: string;
    variant?: "primary" | "secondary" | "ghost";
  };
}

export interface A2UIFormComponent {
  Form: {
    children: A2UIChildList;
    submitAction: string;
    submitLabel?: string;
  };
}

export interface A2UIInputComponent {
  Input: {
    placeholder?: string;
    bindTo: string;
    inputType?: "text" | "number" | "email" | "password";
  };
}

export interface A2UIChartComponent {
  Chart: {
    chartType: "bar" | "line" | "pie";
    data: A2UITextValue;
    title?: string;
  };
}

export type A2UIComponentDef =
  | A2UITextComponent
  | A2UIColumnComponent
  | A2UIRowComponent
  | A2UIImageComponent
  | A2UITableComponent
  | A2UIButtonComponent
  | A2UIFormComponent
  | A2UIInputComponent
  | A2UIChartComponent;

export interface A2UIComponentEntry {
  id: string;
  component: A2UIComponentDef;
}

// ── Protocol messages ──

export interface A2UISurfaceUpdate {
  surfaceId: string;
  title?: string;
  components: A2UIComponentEntry[];
}

export interface A2UIBeginRendering {
  surfaceId: string;
  root: string;
}

export interface A2UIDataModelUpdate {
  surfaceId: string;
  bindings: Record<string, unknown>;
}

export interface A2UIDeleteSurface {
  surfaceId: string;
}

export type A2UIMessage =
  | { surfaceUpdate: A2UISurfaceUpdate }
  | { beginRendering: A2UIBeginRendering }
  | { dataModelUpdate: A2UIDataModelUpdate }
  | { deleteSurface: A2UIDeleteSurface };

// ── Client-side surface state ──

export interface A2UISurface {
  surfaceId: string;
  title: string;
  root: string | null;
  components: Record<string, A2UIComponentEntry>;
  bindings: Record<string, unknown>;
  /** true once beginRendering has been received; only reset to false on deleteSurface */
  rendering: boolean;
}

export interface A2UISurfaceListItem {
  id: string;
  title: string;
  rendering: boolean;
  createdAt: string;
  updatedAt: string;
}
