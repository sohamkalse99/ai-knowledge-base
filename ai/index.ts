// import { openai } from "@ai-sdk/openai";
import { google} from "@ai-sdk/google";
// import { experimental_wrapLanguageModel as wrapLanguageModel } from "ai";
import { wrapLanguageModel } from 'ai';

import { ragMiddleware } from "./rag-middleware";

// export const customModel = wrapLanguageModel({
//   model: openai("gpt-4o"),
//   middleware: ragMiddleware,
// });

export const customModel = wrapLanguageModel({
  model: google('gemini-1.5-flash-8b"'),
  middleware: ragMiddleware,
});