"use client";

import type { UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { useEffect, useState, useRef } from "react";
import { Files } from "@/components/files";
import { AnimatePresence, motion } from "framer-motion";
import { FileIcon } from "@/components/icons";
import { Message as PreviewMessage } from "@/components/message";
import { useScrollToBottom } from "@/components/use-scroll-to-bottom";
import { Session } from "next-auth";

const suggestedActions = [
  { title: "What's the summary", label: "of these documents?", action: "what's the summary of these documents?" },
  { title: "Who is the author", label: "of these documents?", action: "who is the author of these documents?" },
];

// helper: turn UIMessage.parts into plain text for your <PreviewMessage />
function uiMessageToText(m: UIMessage): string {
  // keep only text parts; ignore tools/images for now
  // (adjust if your app sends non-text parts)
  // @ts-ignore - narrow loosely for runtime safety
  return (m.parts ?? [])
    .map((p: any) => (p?.type === "text" ? p.text : ""))
    .join("");
}

export function Chat({
  id,
  initialMessages,
  session,
}: {
  id: string;
  initialMessages: Array<UIMessage>;
  session: Session | null;
}) {
  const [selectedFilePathnames, setSelectedFilePathnames] = useState<string[]>([]);
  const [isFilesVisible, setIsFilesVisible] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    if (isMounted !== false && session?.user) {
      localStorage.setItem(
        `${session.user.email}/selected-file-pathnames`,
        JSON.stringify(selectedFilePathnames)
      );
    }
  }, [selectedFilePathnames, isMounted, session]);


  useEffect(() => setIsMounted(true), []);

  useEffect(() => {
    if (session?.user) {
      setSelectedFilePathnames(
        JSON.parse(
          localStorage.getItem(`${session.user.email}/selected-file-pathnames`) || "[]"
        )
      );
      
    
    }
  }, [session]);

  // v5: manage your own input state
  const [input, setInput] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  const { messages, sendMessage, stop, regenerate, error } = useChat({
    // selected file paths are sent with sendMessage (see onSubmit)
    // v5: seed messages via `messages`, not `initialMessages`
    messages: initialMessages,
    onFinish: () => {
      window.history.replaceState({}, "", `/${id}`);
    },
    
  });

  const [messagesContainerRef, messagesEndRef] = useScrollToBottom<HTMLDivElement>();

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim()) return;
    console.log("Input:", input);
    console.log("Selected files at submit:", selectedFilePathnames);
    sendMessage(({
      role: "user",
      parts: [{ type: "text", text: input }],
      data: {
        id,
        selectedFilePathnames,
      },
    } as any)); // v5 API
    setInput("");
  };

  const triggerSuggested = (text: string) => {
  const t = text.trim();
  
  if (!t) return;
   sendMessage(({
    role: "user",
    parts: [{ type: "text", text: t }],
    data: {
      id,
      selectedFilePathnames,
    },
  } as any));
  };

  return (
    <div className="flex flex-row justify-center pb-20 h-dvh bg-white dark:bg-zinc-900">
      <div className="flex flex-col justify-between items-center gap-4">
        <div
          ref={messagesContainerRef}
          className="flex flex-col gap-4 h-full w-dvw items-center overflow-y-scroll"
        >
          {messages.map((message, index) => (
            <PreviewMessage
              key={`${id}-${index}`}
              role={message.role}
              content={uiMessageToText(message)} // v5 -> parts[] to string
            />
          ))}
          <div ref={messagesEndRef} className="flex-shrink-0 min-w-[24px] min-h-[24px]" />
        </div>

        {messages.length === 0 && (
          <div className="grid sm:grid-cols-2 gap-2 w-full px-4 md:px-0 mx-auto md:max-w-[500px]">
            {suggestedActions.map((s, index) => (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 * index }}
                key={index}
                className={index > 1 ? "hidden sm:block" : "block"}
              >
                <button
                  onClick={() => triggerSuggested(s.action)}
                  className="w-full text-left border border-zinc-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-300 rounded-lg p-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex flex-col"
                >
                  <span className="font-medium">{s.title}</span>
                  <span className="text-zinc-500 dark:text-zinc-400">{s.label}</span>
                </button>
              </motion.div>
            ))}
          </div>
        )}

        <form
          ref={formRef}
          className="flex flex-row gap-2 relative items-center w-full md:max-w-[500px] max-w-[calc(100dvw-32px)] px-4 md:px-0"
          onSubmit={onSubmit}
        >
          <input
            className="bg-zinc-100 rounded-md px-2 py-1.5 flex-1 outline-none dark:bg-zinc-700 text-zinc-800 dark:text-zinc-300"
            placeholder="Send a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />

          <div
            className="relative text-sm bg-zinc-100 rounded-lg size-9 flex-shrink-0 flex flex-row items-center justify-center cursor-pointer hover:bg-zinc-200 dark:text-zinc-50 dark:bg-zinc-700 dark:hover:bg-zinc-800"
            onClick={() => setIsFilesVisible(!isFilesVisible)}
          >
            <FileIcon />
            <motion.div
              className="absolute text-xs -top-2 -right-2 bg-blue-500 size-5 rounded-full flex flex-row justify-center items-center border-2 dark:border-zinc-900 border-white text-blue-50"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.5 }}
            >
              {selectedFilePathnames?.length}
            </motion.div>
          </div>
        </form>
      </div>

      <AnimatePresence>
        {isFilesVisible && (
          <Files
            setIsFilesVisible={setIsFilesVisible}
            selectedFilePathnames={selectedFilePathnames}
            setSelectedFilePathnames={setSelectedFilePathnames}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
