// app/(chat)/api/chat/route.ts
import {
  streamText,
  createUIMessageStreamResponse,
  wrapLanguageModel, // ✅ v5
} from "ai";
import { google } from "@ai-sdk/google";
import { ragMiddleware } from "@/ai/rag-middleware";
import { createMessage, getChatById } from "@/app/db";
import { auth } from "@/app/(auth)/auth";
// Model + middleware
const baseModel = google("gemini-2.0-flash");
const model = wrapLanguageModel({ model: baseModel, middleware: ragMiddleware });
console.log("[ROUTE] model:", model)
// ---- helpers & types (define them in this file) ----
type AnyMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content?: Array<{ type: "text"; text: string } | any>;
  parts?: Array<{ type?: string; text?: string } | string>;
  id?: string;
};

function extractTextParts(partsOrContent: any[] | undefined) {
  if (!Array.isArray(partsOrContent)) return [];
  const out: { type: "text"; text: string }[] = [];
  for (const p of partsOrContent) {
    if (!p) continue;
    if (typeof p === "string") {
      const t = p.trim();
      if (t) out.push({ type: "text", text: t });
      continue;
    }
    const text =
      typeof p.text === "string" ? p.text :
      p.type === "text" && typeof p.text === "string" ? p.text :
      undefined;
    if (typeof text === "string" && text.trim()) {
      out.push({ type: "text", text: text.trim() });
    }
  }
  return out;
}

function normalizeMessages(incoming: AnyMessage[]) {
  return (incoming ?? [])
    .map((m: AnyMessage) => {
      const parts = (m.parts ?? m.content) as any[] | undefined;
      const textParts = extractTextParts(parts);
      return { role: m.role, content: textParts };
    })
    .filter((m) => m.content.length > 0);
}

// ---- handler ----
export async function POST(req: Request) {
  const body = await req.json();

  console.log("RAW BODY:\n", JSON.stringify(body, null, 2));

  const rawMessages = (body?.messages ?? []) as AnyMessage[];
  const messages = normalizeMessages(rawMessages);

  if (!messages.length) {
    return new Response("No non-empty input provided.", { status: 400 });
  }

  // Robustly extract selectedFilePathnames from any incoming message (client puts it
 // on the user message). Fall back to body.data / body.selectedFilePathnames.
 const selectedFilePathnames: string[] = (() => {
   if (Array.isArray(body?.messages)) {
     for (const m of body.messages as any[]) {
       const sel = m?.data?.selectedFilePathnames ?? m?.data?.selectedFilePathnames;
       if (Array.isArray(sel)) return sel;
     }
   }
   const fallback = body?.data?.selectedFilePathnames ?? body?.selectedFilePathnames ?? [];
   return Array.isArray(fallback) ? fallback : [];
 })();
 console.log("[ROUTE] selectedFilePathnames:", selectedFilePathnames);
 
  const selectionMsg = {
    role: "system" as const,
    // Make the control message a UI-style text part array so rag middleware
    // that looks for text parts will find it reliably.
    content: [
      { type: "text" as const, text: `__FILES__ ${JSON.stringify(selectedFilePathnames)}` },
    ],
  };

  // Persist a chat row early so refresh won't 404.  
  // Client sends an `id` with the message (see components/chat.tsx -> sendMessage data).  
    // Find chat id from any message that carried it (client puts it on the user message).
 const chatId: string | null =
   (Array.isArray(body?.messages) &&
     ((body.messages as any[]).find((m: any) => m?.data?.id)?.data?.id)) ??
   body?.data?.id ??
   body?.id ??
   null;

 // debug: log incoming messages and found id
 console.log("[ROUTE] incoming messages count:", Array.isArray(body?.messages) ? body.messages.length : 0);
 console.log("[ROUTE] extracted chatId:", chatId);

 let session = null;
 try {
   session = await auth();
   console.log("[ROUTE] session user:", session?.user?.email ?? "no-session");

   if (chatId && session?.user?.email) {
     // store initial messages (include the selection control message)
     await createMessage({
       id:String(chatId),
       messages: [selectionMsg, ...messages],
       author: session.user.email,
     });
     console.log("[ROUTE] persisted initial chat:", chatId);
   } else {
     console.log("[ROUTE] skipping persist (no session or no chatId)");
   }
 } catch (err) {
   console.error("[ROUTE] createMessage failed:", err);
 }

  // Convert UI-style messages (content: [{type:'text',text}]) into simple
  // ModelMessage objects ({role, content: string}) because the model API
  // expects ModelMessage[]; passing UIMessage[] triggers AI_InvalidPromptError.
  const toModelMessage = (m: any) => {
    // m.content may be a string or an array of parts
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    if (Array.isArray(m.content)) {
      const joined = m.content
        .map((p: any) => {
          if (!p) return "";
          if (typeof p === "string") return p;
          if (typeof p.text === "string") return p.text;
          if (typeof p.delta === "string") return p.delta;
          if (typeof p?.delta?.text === "string") return p.delta.text;
          return "";
        })
        .join("\n");
      return { role: m.role, content: joined };
    }
    // fallback
    return { role: m.role, content: String(m.content ?? "") };
  };

  const modelMessages = [selectionMsg, ...messages].map(toModelMessage);
  // accumulator used by the fallback reader-copy to collect assistant text
  let assistantTextGlobal = "";
  let fallbackUsed = false;

  if (!modelMessages || modelMessages.length === 0) {
    console.error("No valid messages to send to the model");
    return new Response("No valid input provided.", { status: 400 });
  }

  console.log("[ROUTE] Final payload to Gemini:", JSON.stringify({
    model: model.modelId,
    messages: modelMessages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    })),
    hasFiles: selectedFilePathnames.length > 0
  }, null, 2));

  const result = streamText({
    model,
    // pass modelMessages as `messages` (the middleware reads prompt OR messages)
    messages: modelMessages as any,
    // include providerMetadata so middleware that checks providerMetadata can
    // pick up the selected files directly (some SDK shapes expect metadata here)
    providerMetadata: { files: { selection: selectedFilePathnames } },
    experimental_providerMetadata: { files: { selection: selectedFilePathnames } },
  } as any);
  
  // Add error handling
  if (!result) {
    return new Response("Failed to process the request. Please try again.", { status: 500 });
  }
  // We want to both stream the UI message stream to the client and capture
  // the assistant message so we can persist it into the DB. `toUIMessageStream()`
  // returns a WHATWG ReadableStream; use `tee()` to duplicate it.
  const uiStream = result.toUIMessageStream();
  // console.log("[ROUTE] uiStream:", uiStream);
  let clientStream = uiStream;
  let monitorStream = null as any;
  try {
    const tees = (uiStream as any).tee?.();
    // console.log("[ROUTE] tees:", tees);
    if (tees && tees.length === 2) {
      clientStream = tees[0];
      monitorStream = tees[1];
    }
  } catch (e) {
    // if tee isn't available, fallback to single stream (we won't persist assistant)
    console.warn("[ROUTE] stream tee() not available, will use reader-copy fallback", e);
    monitorStream = null;
  }

  // If tee() wasn't available, create a reader-based fallback that will both
  // forward messages to the client and accumulate assistant text for persistence.
  if (!monitorStream) {
    try {
      const reader = (uiStream as any).getReader?.();
      if (reader) {
        // create a client stream that reads from the model stream and forwards
        // each chunk to the client while also accumulating assistant text.
        const fallbackClient = new ReadableStream({
          async start(controller) {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // forward chunk to client
                try { controller.enqueue(value); } catch (e) {}

                // also normalize and append to assistantText (for persistence)
                try {
                  let uiMessage = value;
                  if (value instanceof Uint8Array) {
                    const s = new TextDecoder().decode(value);
                    try { uiMessage = JSON.parse(s); } catch { uiMessage = s; }
                  } else if (typeof value === 'string') {
                    try { uiMessage = JSON.parse(value); } catch { uiMessage = value; }
                  }

                  if (uiMessage && typeof uiMessage === 'object' && uiMessage.role === 'assistant') {
                    const parts = uiMessage.parts ?? uiMessage.content ?? [];
                    for (const p of parts) {
                      if (!p) continue;
                      if (typeof p === 'string') assistantTextGlobal += p;
                      else if (typeof p.text === 'string') assistantTextGlobal += p.text;
                    }
                  } else if (typeof uiMessage === 'string') {
                    assistantTextGlobal += uiMessage;
                  }
                } catch (e) { /* ignore per-chunk errors */ }
              }
            } catch (e) {
              console.error('[ROUTE] fallback reader error', e);
            } finally {
              try { controller.close(); } catch {}

              // persist assistantTextGlobal if present
              if (assistantTextGlobal.trim().length > 0 && chatId) {
                try {
                  const existing = await getChatById({ id: String(chatId) });
                  console.log("[ROUTE] existing chat:", existing);
                  const currentMessages = existing?.messages ? JSON.parse(existing.messages as any) : [];
                  console.log("[ROUTE] currentMessages:", currentMessages);
                  currentMessages.push({ role: "assistant", content: [{ type: "text", text: assistantTextGlobal }] });
                  console.log("[ROUTE] currentMessages after push:", currentMessages);
                  await createMessage({ id: String(chatId), messages: currentMessages, author: session?.user?.email ?? "" });
                  console.log("[ROUTE] appended assistant response to chat (fallback):", chatId);
                } catch (err) {
                  console.error("[ROUTE] failed to append assistant (fallback):", err);
                }
              }
            }
          }
        });

        clientStream = fallbackClient as any;
        // mark that we used the fallback reader; it persists assistantTextGlobal itself
        fallbackUsed = true;
      }
    } catch (e) {
      console.warn('[ROUTE] fallback reader setup failed', e);
    }
  }

  console.log("[ROUTE] clientStream:", clientStream);
  console.log("[ROUTE] monitorStream:", monitorStream);
  console.log("[ROUTE] chatId:", chatId);
  console.log("[ROUTE] fallbackUsed:", fallbackUsed);
  // If we have a monitor stream, consume it in background to collect assistant parts
  if (monitorStream && chatId && !fallbackUsed) {
    (async () => {
      try {
        const reader = (monitorStream as any).getReader?.();
        let assistantText = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          console.log("[ROUTE] Value:", value);
          try {
            let uiMessage = value;

            // value may be Uint8Array, string, or object. Normalize to object if possible.
            if (value instanceof Uint8Array) {
              const s = new TextDecoder().decode(value);
              // try to parse JSON, otherwise treat as raw text
              try {
                uiMessage = JSON.parse(s);
              } catch {
                uiMessage = s;
              }
            } else if (typeof value === "string") {
              try {
                uiMessage = JSON.parse(value);
              } catch {
                uiMessage = value;
              }
            }

            // Minimal debug: log the type of chunk
            console.log("[ROUTE][monitor] ui Message:", uiMessage);

            // If it's an object with role 'assistant', extract text parts
            if (uiMessage && typeof uiMessage === "object" && uiMessage.role === "assistant") {
              const parts = uiMessage.parts ?? uiMessage.content ?? [];
              for (const p of parts) {
                if (!p) continue;
                if (typeof p === "string") assistantText += p;
                else if (typeof p.text === "string") assistantText += p.text;
                else if (typeof p === "object") {
                  // nested shapes: {type:'text', text: '...'} or {delta: {text: '...'}}
                  if (typeof (p as any).delta === "string") assistantText += (p as any).delta;
                  else if (typeof (p as any).delta?.text === "string") assistantText += (p as any).delta.text;
                  else if (typeof (p as any).text === "string") assistantText += (p as any).text;
                }
              }
            } else if (typeof uiMessage === "string") {
              // some streams may directly yield text
              assistantText += uiMessage;
            } else if (Array.isArray(uiMessage)) {
              // sometimes the stream yields an array of parts
              for (const item of uiMessage) {
                if (!item) continue;
                if (typeof item === "string") assistantText += item;
                else if (typeof item.text === "string") assistantText += item.text;
              }
            }
          } catch (e) {
            console.error("[ROUTE] monitorStream msg err", e);
          }
        }

        // stream ended; persist assistantText if any
        if (assistantText.trim().length > 0) {
          try {
            const existing = await getChatById({ id: String(chatId) });
            const currentMessages = existing?.messages ? JSON.parse(existing.messages as any) : [];
            currentMessages.push({ role: "assistant", content: [{ type: "text", text: assistantText }] });
            await createMessage({ id: String(chatId), messages: currentMessages, author: session?.user?.email ?? "" });
            console.log("[ROUTE] appended assistant response to chat:", chatId);
          } catch (err) {
            console.error("[ROUTE] failed to append assistant to chat:", err);
          }
        } else {
          console.log("[ROUTE] no assistantText captured to append for chat:", chatId);
        }
      } catch (e) {
        console.error("[ROUTE] monitorStream error:", e);
      }
    })();
  }

  try {
    const firstUser = messages.find((m) => m.role === "user");
    console.log("FIRST USER TEXT:", firstUser?.content?.map((p: any) => p.text).join(" | "));
  } catch {}

  // Return the client stream (the first tee) so the client receives the same
  // UI messages we are monitoring in background.
  return createUIMessageStreamResponse({
    stream: clientStream,
  });
}
