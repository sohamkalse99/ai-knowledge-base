// import { auth } from "@/app/(auth)/auth";
// import { getChunksByFilePaths } from "@/app/db";
// // import { openai } from "@ai-sdk/openai";
// import { google} from "@ai-sdk/google";

// import {
//   cosineSimilarity,
//   embed,
//   Experimental_LanguageModelV1Middleware,
//   generateObject,
//   generateText,
// } from "ai";
// import { z } from "zod";

// // schema for validating the custom provider metadata
// const selectionSchema = z.object({
//   files: z.object({
//     selection: z.array(z.string()),
//   }),
// });

// export const ragMiddleware: Experimental_LanguageModelV1Middleware = {
//   transformParams: async ({ params }) => {
//     const session = await auth();

//     if (!session) return params; // no user session

//     const { prompt: messages, providerMetadata } = params;

//     // validate the provider metadata with Zod:
//     const { success, data } = selectionSchema.safeParse(providerMetadata);

//     if (!success) return params; // no files selected

//     const selection = data.files.selection;

//     const recentMessage = messages.pop();

//     if (!recentMessage || recentMessage.role !== "user") {
//       if (recentMessage) {
//         messages.push(recentMessage);
//       }

//       return params;
//     }

//     const lastUserMessageContent = recentMessage.content
//       .filter((content) => content.type === "text")
//       .map((content) => content.text)
//       .join("\n");

//     // Classify the user prompt as whether it requires more context or not
//     const { object: classification } = await generateObject({
//       // fast model for classification:
//       // model: openai("gpt-4o-mini", { structuredOutputs: true }),
//       model: google("gemini-1.5-flash-8b", { structuredOutputs: true }),
//       output: "enum",
//       enum: ["question", "statement", "other"],
//       system: "classify the user message as a question, statement, or other",
//       prompt: lastUserMessageContent,
//     });

//     // only use RAG for questions
//     if (classification !== "question") {
//       messages.push(recentMessage);
//       return params;
//     }

//     // Use hypothetical document embeddings:
//     const { text: hypotheticalAnswer } = await generateText({
//       // fast model for generating hypothetical answer:
//       // model: openai("gpt-4o-mini", { structuredOutputs: true }),
//       model: google("gemini-1.5-flash-8b", { structuredOutputs: true }),
//       system: "Answer the users question:",
//       prompt: lastUserMessageContent,
//     });

//     // Embed the hypothetical answer
//     const { embedding: hypotheticalAnswerEmbedding } = await embed({
//       // model: openai.embedding("text-embedding-3-small"),
//       model: google.embedding("text-embedding-004",),
//       value: hypotheticalAnswer,
//     });

//     // find relevant chunks based on the selection
//     const chunksBySelection = await getChunksByFilePaths({
//       filePaths: selection.map((path) => `${session.user?.email}/${path}`),
//     });

//     const chunksWithSimilarity = chunksBySelection.map((chunk) => ({
//       ...chunk,
//       similarity: cosineSimilarity(
//         hypotheticalAnswerEmbedding,
//         chunk.embedding,
//       ),
//     }));

//     // rank the chunks by similarity and take the top K
//     chunksWithSimilarity.sort((a, b) => b.similarity - a.similarity);
//     const k = 10;
//     const topKChunks = chunksWithSimilarity.slice(0, k);

//     // add the chunks to the last user message
//     messages.push({
//       role: "user",
//       content: [
//         ...recentMessage.content,
//         {
//           type: "text",
//           text: "Here is some relevant information that you can use to answer the question:",
//         },
//         ...topKChunks.map((chunk) => ({
//           type: "text" as const,
//           text: chunk.content,
//         })),
//       ],
//     });

//     return { ...params, prompt: messages };
//   },
// };

// ragMiddleware.ts
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

// const selectionSchema = z.object({
//   files: z.object({ selection: z.array(z.string()) }),
// });

export const ragMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    // DEV-ONLY: print a single snapshot of incoming params/prompt to help
    // debug the shape of the selection and messages. This runs at most once
    // per server process to avoid excessive logging in dev.
    try {
      if (!(global as any).__RAG_DEBUG_LOGGED) {
        // Don't stringify blindly — print compact structures to avoid circular errors
        console.log("[RAG DEBUG] params:", params);
        
        console.log("[RAG DEBUG] prompt snapshot:", Array.isArray(params?.prompt) ? params.prompt.slice(0,10) : params?.prompt);
        console.log("[RAG DEBUG] providerMetadata:", (params as any).providerMetadata ?? (params as any).experimental_providerMetadata ?? null);
        (global as any).__RAG_DEBUG_LOGGED = true;
      }
    } catch (e) {
      // ignore debug logging failures
    }
    
    // Accept either `prompt` (v5) or legacy `messages` shape
  // `params` is a LanguageModel call options object; some SDK shapes put the
  // message array under `messages` (legacy) or `prompt` (v5). Use an any cast
  // to safely access both without TypeScript errors.
  const prompt = params?.prompt ?? (params as any)?.messages ?? [];

  const userMsg = params.prompt.find(p => p.role === "user");
  console.log("User message:", userMsg);
    if (userMsg) {
      // if it's an array of parts
      if (Array.isArray(userMsg.content)) {
        const textContent = userMsg.content
          .map((c: any) =>
            typeof c === "string"
              ? c
              : (typeof c?.text === "string" ? c.text : "")
          )
          .join("\n");

        console.log("User content:", textContent);
      } else {
        // if it's just a string
        console.log("User content:", userMsg.content);
      }
    }

    type TextLike =
    | string
    | { type?: string; text?: string }
    | Array<{ type?: string; text?: string }>;

    const FILES_PREFIX = "__FILES__";
    if (!Array.isArray(prompt)) return null;

    // Find a system message that carries the files control info
    const control = prompt.find(
      (m) =>
        m?.role === "system" &&
        (typeof m.content === "string" ||
          Array.isArray(m.content))
    );
    if (!control) return null;

    let textPayload = "";

    if (typeof control.content === "string") {
      // content is a plain string
      textPayload = control.content;
    } else if (Array.isArray(control.content)) {
      // content is an array of parts; find the text-like part
      const textPart = control.content.find(
        (p: any) =>
          (typeof p === "string" && String(p).startsWith(FILES_PREFIX)) ||
          (p?.type === "text" && typeof p.text === "string" && p.text.startsWith(FILES_PREFIX))
      );

      if (typeof textPart === "string") {
        textPayload = textPart;
      }
    }

    if (!textPayload || !textPayload.startsWith(FILES_PREFIX)) return null;

    // Now it's safe to use string methods
    const jsonPart = textPayload.replace(FILES_PREFIX, "").trim();
    let selection = JSON.parse(jsonPart);
    console.log("Selection:", selection);
    // Try to extract selection from provider metadata (standard or experimental)
    // const providerMeta = (params as any).providerMetadata ?? (params as any).experimental_providerMetadata;
    // let selection: string[] | null = null;
    // try {
    //   if (providerMeta?.files?.selection && Array.isArray(providerMeta.files.selection)) {
    //     selection = providerMeta.files.selection;
    //   }
    // } catch (e) {}

    
    // Fallback: look for a control system message like "__FILES__ [..]" in the prompt
    if (!selection) {
      const control = Array.isArray(prompt)
        ? prompt.find((m: any) =>
            m.role === "system" &&
            Array.isArray(m.content) &&
            m.content.some((c: any) => c.type === "text" && String(c.text).startsWith("__FILES__"))
          )
        : undefined;

      if (control) {
        let t = "";
        if (typeof control.content === "string") {
          t = control.content;
        } else if (Array.isArray(control.content)) {
          const contentArr = control.content;
          t = ((contentArr.find((c: any) => (c as any)?.type === "text") as any)?.text) ?? "";
        }
        const jsonPart = String(t).replace("__FILES__", "").trim();
        try {
          const parsed = JSON.parse(jsonPart);
          if (Array.isArray(parsed)) selection = parsed;
        } catch (e) {
          // ignore parse error
        }
      }
    }

    const session = await auth();
    if (!session || !Array.isArray(prompt) || prompt.length === 0) return params;

    // Validate provider metadata (selected files)
    // const parsed = selectionSchema.safeParse(providerMetadata);
    // if (!parsed.success) return params;
    // const selection =
    //   meta?.files?.selection && Array.isArray(meta.files.selection)
    //     ? meta.files.selection
    //     : null;

    // if (!selection || !Array.isArray(prompt) || prompt.length === 0) {
    //   console.log("[RAG] no selection found, skipping RAG middleware");
    //   return params;
    // }

    // Find last user message in `prompt`
    const lastUserIdxFromEnd = [...prompt].reverse().findIndex(m => m.role === "user");
    if (lastUserIdxFromEnd === -1) return params;
    const lastUserIdx = prompt.length - 1 - lastUserIdxFromEnd;

  const recentMessage = prompt.splice(lastUserIdx, 1)[0];
    const recentContentArr = Array.isArray(recentMessage.content)
      ? recentMessage.content
      : [];

    const lastUserMessageText = recentContentArr
      .filter((c: any) => (c as any)?.type === "text" && typeof (c as any).text === "string")
      .map((c: any) => String((c as any).text))
      .join("\n")
      .trim();

    if (!lastUserMessageText) {
      prompt.splice(lastUserIdx, 0, recentMessage);
      return { ...params, prompt };
    }

    // Classify
    const { object } = await generateObject({
      model: google("gemini-1.5-flash-8b"),
      schema: z.object({ kind: z.enum(["question", "statement", "other"]) }),
      prompt: lastUserMessageText,
      system: "Classify the user message.",
    });

    if (object.kind !== "question") {
      prompt.splice(lastUserIdx, 0, recentMessage);
      return { ...params, prompt };
    }

    console.log("Befor hyde")
    // HyDE
    const { text: hypotheticalAnswer } = await generateText({
      model: google("gemini-1.5-flash-8b"),
      system: "Answer the user's question briefly.",
      prompt: lastUserMessageText,
    });

    const { embedding: hypotheticalAnswerEmbedding } = await embed({
      model: google.embedding("text-embedding-004"),
      value: hypotheticalAnswer,
    });

    const userEmail = session.user?.email ?? "";
    console.log("[RAG] userEmail:", userEmail);
    console.log("[RAG] selection from providerMetadata:", selection);
    console.log("[RAG] full filePaths:", selection.map((p) => `${userEmail}/${p}`));

    const filePaths = selection.map((p) => `${userEmail}/${p}`);
    
    const chunksBySelection = await getChunksByFilePaths({ filePaths });
    console.log("[RAG] chunksBySelection:", chunksBySelection);
    if (!Array.isArray(chunksBySelection) || chunksBySelection.length === 0) {
      // nothing found for the selected files; put the original user message back and skip
      console.log("[RAG] no chunks found for filePaths:", filePaths);
      prompt.splice(lastUserIdx, 0, recentMessage);
      return { ...params, prompt };
    }

    const topKChunks = chunksBySelection
      .map((chunk: any) => ({
        ...chunk,
        similarity: cosineSimilarity(hypotheticalAnswerEmbedding, chunk.embedding),
      }))
      .sort((a: any, b: any) => b.similarity - a.similarity)
      .slice(0, 10);
    
      // console.log("[RAG] topKChunks:", topKChunks);
    // Build augmented user content as an array of text parts
    const augmentedUser = {
      role: "user" as const,
      // ensure content is an array of text parts (typed shape)
      content: [
        ...recentContentArr
          .filter((c: any) => (c as any)?.type === "text")
    .map((c: any) => ({ type: "text" as const, text: String((c as any).text) })),
    { type: "text" as const, text: "Here is some relevant information to answer the question:" },
    ...topKChunks.map((c: any) => ({ type: "text" as const, text: String(c.content) })),
      ],
    };
    // console.log("[RAG] augmentedUser:", augmentedUser);
    prompt.splice(lastUserIdx, 0, augmentedUser);

    // Convert the UI-style `prompt` (array of parts/content arrays) into
    // ModelMessage[] (role + single string content) because the model API
    // expects ModelMessage[]. This avoids the AI_InvalidPromptError.
    const modelPrompt = (prompt as any[]).map((m) => {
      const contentArr = Array.isArray(m.content) ? m.content : [m.content];
      const text = contentArr
        .map((c: any) => {
          if (!c) return "";
          if (typeof c === "string") return c;
          if (typeof c.text === "string") return c.text;
          if (typeof c.delta === "string") return c.delta;
          if (typeof c?.delta?.text === "string") return c.delta.text;
          return "";
        })
        .join("\n");
      return { role: m.role, content: text };
    });

    // Transform messages to Gemini's format
  const geminiMessages = modelPrompt.map(msg => {
    // For system messages, include them as user messages with appropriate formatting
    if (msg.role === 'system') {
      return {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: msg.content }]
      };
    }
    
    // For user messages, ensure content is properly formatted
    if (msg.role === 'user') {
      return {
        role: 'user' as const,
        content: Array.isArray(msg.content)
          ? msg.content.map(part => 
              typeof part === 'string' 
                ? { type: 'text' as const, text: part }
                : part
            )
          : [{ type: 'text' as const, text: String(msg.content) }]
      };
    }
    
    return msg;
  });

  // Ensure we have at least one user message
  if (!geminiMessages.some(m => m.role === 'user')) {
    console.error('[RAG] No user message found in the prompt');
    return params; // Fallback to original params
  }
  
    return { ...params, prompt: geminiMessages };
  },
};

