import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as ReactMarkdownOptions } from "react-markdown";

const remarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [remarkGfm];

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Allow class on all elements (needed for cb-markdown children + GFM)
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
    // GFM task-list checkboxes
    input: [...(defaultSchema.attributes?.["input"] ?? []), ["type", "checkbox"], "checked", "disabled"],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), "input"],
};

const rehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [[rehypeSanitize, sanitizeSchema]];

interface Props {
  content: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: Props) {
  return (
    <ReactMarkdown
      className="cb-markdown text-sm leading-relaxed text-foreground/90"
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
    >
      {content}
    </ReactMarkdown>
  );
});
