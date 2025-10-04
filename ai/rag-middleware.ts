// ragMiddleware.ts (clean, parts-array end-to-end)

import {
  cosineSimilarity,
  embed,
  generateObject,
  generateText,
  type LanguageModelMiddleware,
} from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { getChunksByFilePaths } from "@/app/db";

/* -------------------------- Small normalization helpers -------------------------- */

// Force any content into an array of {type:'text', text: string} parts.
function toParts(content: any): Array<{ type: "text"; text: string }> {
  if (Array.isArray(content)) {
    return content
      .flatMap((p) => {
        if (!p) return [];
        if (typeof p === "string") return [{ type: "text" as const, text: p }];
        if (typeof p?.text === "string") return [{ type: "text" as const, text: p.text }];
        if (typeof (p as any)?.delta === "string") return [{ type: "text" as const, text: (p as any).delta }];
        if (typeof (p as any)?.delta?.text === "string") return [{ type: "text" as const, text: (p as any).delta.text }];
        return [];
      })
      .filter((p) => typeof p.text === "string" && p.text.trim().length > 0);
  }
  const s = String(content ?? "").trim();
  return s ? [{ type: "text", text: s }] : [];
}

type PartsMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: Array<{ type: "text"; text: string }>;
};

// Ensure each message has parts content; keep roles as-is for now.
function normalizePromptToParts(prompt: any): PartsMessage[] {
  if (!Array.isArray(prompt)) return [];
  return prompt
    .map((m) => ({
      role: m?.role,
      content: toParts(m?.content),
    }))
    .filter((m) => m.role && Array.isArray(m.content));
}

// Gemini commonly prefers no `system` role. Convert those to user with the same parts.
function mapSystemToUser(messages: PartsMessage[]): PartsMessage[] {
  return messages.map((m) =>
    m.role === "system" ? { role: "user", content: m.content } : m
  ) as PartsMessage[];
}

// Read the __FILES__ control payload from any system message's text parts.
function extractSelectionFromPromptParts(messages: PartsMessage[]): string[] | null {
  const FILES_PREFIX = "__FILES__";
  for (const m of messages) {
    if (m.role !== "system") continue;
    for (const p of m.content) {
      const t = p.text?.trim?.() ?? "";
      if (t.startsWith(FILES_PREFIX)) {
        const json = t.slice(FILES_PREFIX.length).trim();
        try {
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed)) return parsed as string[];
        } catch (_) {
          // ignore; keep looking
        }
      }
    }
  }
  return null;
}

// Get last user message index; -1 if none.
function lastUserIndex(messages: PartsMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

// Extract pure text (joined by \n) from parts.
function partsToText(parts: Array<{ type: "text"; text: string }>): string {
  return parts.map((p) => p.text).join("\n").trim();
}

/* --------------------------------- Middleware ---------------------------------- */

export const ragMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    // 1) Normalize incoming prompt to parts arrays (support v5 `prompt` or legacy `messages`)
    const rawPrompt = (params as any)?.prompt ?? (params as any)?.messages ?? [];
    let prompt: PartsMessage[] = normalizePromptToParts(rawPrompt);

    if (prompt.length === 0) return params; // nothing to do

    // 2) Try to read file selection from __FILES__ control message
    let selection = extractSelectionFromPromptParts(prompt) ?? [];

    // 3) Require auth for RAG (multi-tenant paths)
    const session = await auth();
    if (!session) {
      // still normalize roles for Gemini and return
      return { ...params, prompt: mapSystemToUser(prompt) };
    }

    // 4) Find last user message
    const uIdx = lastUserIndex(prompt);
    if (uIdx === -1) {
      return { ...params, prompt: mapSystemToUser(prompt) };
    }

    // 5) Pull last user message (temporarily)
    const recent = prompt.splice(uIdx, 1)[0]; // remove last user
    const recentText = partsToText(recent.content);
    if (!recentText) {
      // put it back unchanged
      prompt.splice(uIdx, 0, recent);
      return { ...params, prompt: mapSystemToUser(prompt) };
    }

    // 6) Classify if this needs RAG (question only)
    try {
      const { object } = await generateObject({
        model: google('gemini-2.0-flash'),
        schema: z.object({ kind: z.enum(["question", "statement", "other"]) }),
        prompt: recentText,
        system: "Classify the user message.",
      });

      if (object.kind !== "question") {
        // Replace original user turn unchanged; no augmentation
        prompt.splice(uIdx, 0, recent);
        return { ...params, prompt: mapSystemToUser(prompt) };
      }
    } catch {
      // On classifier failure, be conservative: don't augment
      prompt.splice(uIdx, 0, recent);
      return { ...params, prompt: mapSystemToUser(prompt) };
    }

    // 7) HyDE → embed
    let hypotheticalAnswer = "";
    try {
      const { text } = await generateText({
        model: google('gemini-2.0-flash'),
        system: "Answer the user's question briefly.",
        prompt: recentText,
      });
      hypotheticalAnswer = text ?? "";
    } catch {
      // If HyDE fails, skip augmentation gracefully
      prompt.splice(uIdx, 0, recent);
      return { ...params, prompt: mapSystemToUser(prompt) };
    }

    let hydeEmbedding: number[] | null = null;
    try {
      const { embedding } = await embed({
        model: google.embedding("text-embedding-004"),
        value: hypotheticalAnswer || recentText, // fallback to question text
      });
      hydeEmbedding = embedding;
    } catch {
      // embedding failed → skip augmentation
      prompt.splice(uIdx, 0, recent);
      return { ...params, prompt: mapSystemToUser(prompt) };
    }

    // 8) Retrieve chunks for selected files
    const email = session.user?.email ?? "";
    const filePaths = (selection ?? []).map((p) => `${email}/${p}`);
    let chunks: Array<{ content: string; embedding: number[] }> = [];
    try {
      chunks = (await getChunksByFilePaths({ filePaths })) as any[];
    } catch {
      // retrieval failed → skip augmentation
      prompt.splice(uIdx, 0, recent);
      return { ...params, prompt: mapSystemToUser(prompt) };
    }

    if (!Array.isArray(chunks) || chunks.length === 0) {
      // no context → restore original
      prompt.splice(uIdx, 0, recent);
      return { ...params, prompt: mapSystemToUser(prompt) };
    }

    // 9) Rank by cosine to HyDE and take top-K
    const topK = chunks
      .map((c) => ({
        ...c,
        similarity: cosineSimilarity(hydeEmbedding!, c.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10);

    // 10) Build the **augmented** last user turn (parts arrays only)
    const augmentedUser: PartsMessage = {
      role: "user",
      content: [
        ...recent.content, // original user text parts
        { type: "text", text: "Here is some relevant information to answer the question:" },
        ...topK.map((c) => ({ type: "text" as const, text: String(c.content ?? "") })),
      ],
    };

    // 11) Put the augmented turn back at the same index
    prompt.splice(uIdx, 0, augmentedUser);

    // 12) Map roles for Gemini and return (still parts arrays, no string roundtrip)
    const geminiReady = mapSystemToUser(prompt);
    return { ...params, prompt: geminiReady };
  },
};
