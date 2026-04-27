import { tool } from "ai";
import { z } from "zod";
import { IMAGE_GEN_PROVIDERS } from "../provider-registry.ts";
import type { NativeToolContentItem, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Image Generation tool
// ---------------------------------------------------------------------------
const GENERATE_IMAGE_NAME = "native__generate_image";

const generateImageToolDef = tool({
  description:
    "[Image Generation] Generate images from text prompts using AI models (OpenAI GPT Image / DALL-E, Flux via Replicate/Fal). Returns the generated image(s).",
  parameters: z.object({
    prompt: z.string().describe("Detailed description of the image to generate"),
    model: z
      .string()
      .optional()
      .describe(
        "Model override: gpt-image-1, dall-e-3, dall-e-2, or a Flux model ID. Uses configured default if omitted",
      ),
    size: z
      .string()
      .optional()
      .describe("Image dimensions as WxH (e.g. 1024x1024, 1024x1792, 1792x1024). Default: 1024x1024"),
    quality: z
      .enum(["auto", "low", "medium", "high"])
      .optional()
      .describe("Image quality (default: auto)"),
    style: z
      .enum(["vivid", "natural"])
      .optional()
      .describe("Image style (DALL-E 3 only). vivid = hyper-real/dramatic, natural = organic/less hyper-real"),
    n: z
      .number()
      .min(1)
      .max(4)
      .optional()
      .describe("Number of images to generate (default: 1, DALL-E 3 limited to 1)"),
    output_format: z
      .enum(["png", "webp"])
      .optional()
      .describe("Output format (OpenAI gpt-image-1 only). Default: png"),
    background: z
      .enum(["auto", "transparent"])
      .optional()
      .describe("Background handling (OpenAI gpt-image-1 only). transparent requires png or webp output"),
  }),
});

/** Look up a model ID across all image-gen providers. */
function resolveImageModel(
  modelOverride: string,
): { providerId: string; modelId: string } | null {
  for (const provider of IMAGE_GEN_PROVIDERS) {
    const match = provider.models.find((m) => m.id === modelOverride);
    if (match) return { providerId: provider.id, modelId: match.id };
  }
  return null;
}

const handleGenerateImage: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  const prompt = String(args.prompt);
  const size = args.size ? String(args.size) : "1024x1024";
  const quality = args.quality ? String(args.quality) : undefined;
  const n = typeof args.n === "number" ? args.n : 1;
  const style = args.style ? String(args.style) : undefined;
  const outputFormat = args.output_format ? String(args.output_format) : undefined;
  const background = args.background ? String(args.background) : undefined;

  // Resolve the image-generation model config
  let providerId: string;
  let modelId: string;
  let apiKey: string;

  try {
    const { resolveMediaConfig, resolveCredential } = await import("../llm-router.ts");

    // Per-call model override: look up the model in the registry
    if (args.model) {
      const override = resolveImageModel(String(args.model));
      if (!override) {
        const allModels = IMAGE_GEN_PROVIDERS.flatMap((p) =>
          p.models.map((m) => m.id),
        );
        return {
          content: [
            {
              type: "text",
              text: `Unknown image model: "${args.model}". Available models: ${allModels.join(", ")}`,
            },
          ],
        };
      }
      providerId = override.providerId;
      modelId = override.modelId;
      const cred = resolveCredential(override.providerId);
      apiKey = cred.apiKey;
    } else {
      const config = resolveMediaConfig("image-generation");
      providerId = config.providerId;
      modelId = config.model;
      apiKey = config.apiKey;
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Image generation not available: ${err instanceof Error ? err.message : String(err)}. Configure an image generation model in Settings > Media.`,
        },
      ],
    };
  }

  try {
    const ai = await import("ai");
    const genImage = ai.experimental_generateImage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let imageModel: any;

    switch (providerId) {
      case "openai": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        const provider = createOpenAI({ apiKey });
        imageModel = provider.image(modelId);
        break;
      }
      case "replicate": {
        // Dynamic import — optional dependency
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = await (Function('return import("@ai-sdk/replicate")')() as Promise<any>);
          const provider = mod.createReplicate({ apiToken: apiKey });
          imageModel = provider.image(modelId);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "Replicate provider not installed. Run: pnpm add @ai-sdk/replicate",
              },
            ],
          };
        }
        break;
      }
      case "fal": {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = await (Function('return import("@ai-sdk/fal")')() as Promise<any>);
          const provider = mod.createFal({ apiKey });
          imageModel = provider.image(modelId);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "Fal.ai provider not installed. Run: pnpm add @ai-sdk/fal",
              },
            ],
          };
        }
        break;
      }
      default:
        return {
          content: [
            {
              type: "text",
              text: `Unsupported image generation provider: ${providerId}. Supported: openai, replicate, fal`,
            },
          ],
        };
    }

    // Build provider-specific options (quality, style, output_format, background)
    const providerOptions: Record<string, Record<string, string>> = {};
    if (providerId === "openai") {
      const openaiOpts: Record<string, string> = {};
      if (quality) openaiOpts.quality = quality;
      if (style) openaiOpts.style = style;
      if (outputFormat) openaiOpts.output_format = outputFormat;
      if (background) openaiOpts.background = background;
      if (Object.keys(openaiOpts).length > 0) {
        providerOptions.openai = openaiOpts;
      }
    }

    const result = await genImage({
      model: imageModel,
      prompt,
      n,
      size: size as `${number}x${number}`,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    });

    // Convert generated images to NativeToolResult with image content items
    const content: NativeToolContentItem[] = [];
    const images = result.images ?? (result.image ? [result.image] : []);

    for (const img of images) {
      if (img?.base64) {
        content.push({
          type: "image",
          data: img.base64,
          mimeType: img.mimeType ?? "image/png",
        });
      }
    }

    if (content.length === 0) {
      content.push({
        type: "text",
        text: "Image generation completed but no images were returned.",
      });
    } else {
      content.push({
        type: "text",
        text: `Generated ${content.length} image(s) for: "${prompt}"`,
      });
    }

    return { content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Image generation failed: ${msg}` }],
    };
  }
};

export const imageModule: NativeToolModule = {
  group: "image",
  defs: { [GENERATE_IMAGE_NAME]: generateImageToolDef },
  handlers: { [GENERATE_IMAGE_NAME]: handleGenerateImage },
};
