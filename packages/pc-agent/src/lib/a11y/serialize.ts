import type { A11yNode, A11yTree } from "./types.ts";

export interface SerializeOptions {
  /** Max depth to traverse (default: 6) */
  maxDepth?: number;
  /** Max nodes to include (default: 300) */
  maxNodes?: number;
  /** Only include visible/non-empty nodes (default: true) */
  filterEmpty?: boolean;
}

/**
 * Serialize an accessibility tree into a compact text format for LLM consumption.
 *
 * Output format:
 * ```
 * [1] window "Firefox"
 *   [2] toolbar "Navigation"
 *     [3] textfield "URL" value="https://..." focused
 *     [4] button "Reload"
 *   [5] document "Example Domain"
 *     [6] link "More information..."
 * ```
 *
 * Compact, with IDs for action targeting. The LLM can reference nodes by ID.
 */
export function serializeA11yTree(tree: A11yTree, opts?: SerializeOptions): string {
  const maxDepth = opts?.maxDepth ?? 6;
  const maxNodes = opts?.maxNodes ?? 300;
  const filterEmpty = opts?.filterEmpty ?? true;

  const lines: string[] = [];
  let nodeCount = 0;

  function visit(node: A11yNode, depth: number): void {
    if (nodeCount >= maxNodes) return;
    if (depth > maxDepth) return;

    // Skip empty/unnamed nodes (unless they have children worth showing)
    if (filterEmpty && !node.name && !node.value && (!node.children || node.children.length === 0)) {
      return;
    }

    const indent = "  ".repeat(depth);
    let line = `${indent}[${node.id}] ${node.role}`;

    if (node.name) {
      line += ` "${node.name}"`;
    }

    if (node.value) {
      // Truncate long values
      const val = node.value.length > 80 ? node.value.slice(0, 77) + "..." : node.value;
      line += ` value="${val}"`;
    }

    if (node.states && node.states.length > 0) {
      line += ` ${node.states.join(" ")}`;
    }

    lines.push(line);
    nodeCount++;

    if (node.children) {
      for (const child of node.children) {
        visit(child, depth + 1);
      }
    }
  }

  visit(tree.root, 0);
  return lines.join("\n");
}

/** Find a node by ID in the tree (for resolving actions) */
export function findNodeById(tree: A11yTree, id: number): A11yNode | null {
  function search(node: A11yNode): A11yNode | null {
    if (node.id === id) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
    }
    return null;
  }
  return search(tree.root);
}
