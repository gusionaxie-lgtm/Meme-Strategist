import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Terminal, Bot, User, Loader2, AlertTriangle } from "lucide-react";
import {
  useGetOpenaiConversation,
  useCreateOpenaiConversation,
  useUpdateProject,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "@/components/markdown-renderer";

interface ChatMessage {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
}

interface AiChatProps {
  projectId: number;
  initialConversationId?: number | null;
}

export default function AiChat({ projectId, initialConversationId }: AiChatProps) {
  const [conversationId, setConversationId] = useState<number | null>(
    initialConversationId ?? null
  );
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: conversation, refetch: refetchConversation } = useGetOpenaiConversation(
    conversationId ?? 0,
    { query: { enabled: !!conversationId } }
  );

  const createConversation = useCreateOpenaiConversation();
  const updateProject = useUpdateProject();

  useEffect(() => {
    if (conversation?.messages && Array.isArray(conversation.messages)) {
      const normalized: ChatMessage[] = conversation.messages.map((m: any, i: number) => ({
        id: m.id ?? i,
        role: (m.role === "user" || m.role === "assistant") ? m.role : "assistant",
        content: typeof m.content === "string" ? m.content : "",
      }));
      setMessages(normalized);
    }
  }, [conversation]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const pushError = (text: string) => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.id === "streaming") {
        last.content = text;
        last.isError = true;
      } else {
        next.push({ id: `err-${Date.now()}`, role: "assistant", content: text, isError: true });
      }
      return next;
    });
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = input.trim();
    if (!query || isStreaming) return;

    setInput("");
    setInitError(null);

    const userMsg: ChatMessage = { id: Date.now(), role: "user", content: query };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);

    try {
      let currentConvId = conversationId;

      if (!currentConvId) {
        let newConv: any;
        try {
          newConv = await createConversation.mutateAsync({
            data: { title: `Project ${projectId} Strategy Session` },
          });
        } catch (err) {
          pushError("Failed to initialize strategy session. Please try again.");
          setIsStreaming(false);
          return;
        }

        if (!newConv?.id) {
          pushError("Session initialization failed — no ID returned.");
          setIsStreaming(false);
          return;
        }

        currentConvId = newConv.id;
        setConversationId(currentConvId);

        try {
          await updateProject.mutateAsync({
            id: projectId,
            data: { conversationId: currentConvId },
          });
        } catch {
          // Non-fatal: project link failed but chat can still work
        }
      }

      // Add streaming placeholder
      const streamingPlaceholder: ChatMessage = {
        id: "streaming",
        role: "assistant",
        content: "",
      };
      setMessages((prev) => [...prev, streamingPlaceholder]);

      const response = await fetch(
        `/api/openai/conversations/${currentConvId}/messages?projectId=${projectId}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: query }),
        }
      );

      if (!response.ok) {
        let errMsg = `Strategist offline (${response.status}).`;
        try {
          const body = await response.json();
          if (body?.error) errMsg = body.error;
        } catch {
          // ignore
        }
        pushError(errMsg);
        setIsStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        pushError("Stream unavailable. Please retry.");
        setIsStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        let done: boolean;
        let value: Uint8Array | undefined;

        try {
          ({ done, value } = await reader.read());
        } catch {
          pushError("Stream interrupted. The response may be incomplete.");
          break;
        }

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const data = JSON.parse(dataStr);

            if (typeof data.content === "string" && data.content.length > 0) {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.id === "streaming") {
                  last.content += data.content;
                }
                return next;
              });
            }

            if (data.done === true) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === "streaming" ? { ...m, id: `msg-${Date.now()}` } : m
                )
              );
              try { refetchConversation(); } catch { /* non-fatal */ }
            }
          } catch {
            // Incomplete JSON chunk — ignore
          }
        }
      }
    } catch (err) {
      console.error("[AiChat] Unexpected error:", err);
      pushError("Unexpected error. Please try again.");
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <Card className="glass-card rounded-none border-border h-full flex flex-col overflow-hidden">
      <CardHeader className="border-b border-border/50 py-3 px-4 bg-black/20 shrink-0">
        <CardTitle className="text-sm font-mono flex items-center gap-2">
          <Terminal className="h-4 w-4 text-primary" />
          CLAB_STRATEGIST
          {isStreaming && (
            <span className="ml-auto text-xs text-primary/70 font-normal animate-pulse">
              processing...
            </span>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="flex-1 p-0 flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4 text-muted-foreground opacity-50 py-16 min-h-[200px]">
              <Bot className="h-10 w-10" />
              <p className="text-sm font-mono">
                Strategist initialized.
                <br />
                Ask for analysis, lore, or market strategy.
              </p>
            </div>
          ) : (
            messages.map((msg, i) => (
              <MessageBubble key={msg.id ?? i} msg={msg} isStreaming={isStreaming} />
            ))
          )}

          {initError && (
            <div className="flex items-center gap-2 text-xs text-destructive font-mono p-2 border border-destructive/30 rounded-sm bg-destructive/5">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {initError}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="p-3 border-t border-border/50 bg-black/20 shrink-0">
          <form onSubmit={handleSend} className="flex items-center gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Query the strategist..."
              className="flex-1 rounded-none border-border bg-black/40 font-mono text-xs focus-visible:ring-primary focus-visible:border-primary"
              disabled={isStreaming}
              autoComplete="off"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!input.trim() || isStreaming}
              className="rounded-none bg-primary text-primary-foreground hover:bg-primary/90 glow-green shrink-0"
            >
              {isStreaming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

function MessageBubble({
  msg,
  isStreaming,
}: {
  msg: ChatMessage;
  isStreaming: boolean;
}) {
  const isUser = msg.role === "user";
  const isStreamingThis = isStreaming && msg.id === "streaming";

  return (
    <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}>
      <div
        className={cn(
          "h-7 w-7 rounded-sm flex items-center justify-center shrink-0 border mt-0.5",
          isUser
            ? "bg-secondary text-secondary-foreground border-secondary/50"
            : msg.isError
            ? "bg-destructive/10 text-destructive border-destructive/30"
            : "bg-primary/10 text-primary border-primary/30 glow-green"
        )}
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : msg.isError ? <AlertTriangle className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>

      <div
        className={cn(
          "px-3 py-2.5 rounded-sm text-sm max-w-[85%]",
          isUser
            ? "bg-secondary/50 border border-secondary/20 font-mono text-sm"
            : msg.isError
            ? "bg-destructive/5 border border-destructive/20 text-destructive font-mono text-xs"
            : "bg-black/40 border border-border/50 text-muted-foreground"
        )}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap break-words">{msg.content}</span>
        ) : isStreamingThis && !msg.content ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
            <Loader2 className="h-3 w-3 animate-spin" />
            Strategist is thinking...
          </span>
        ) : (
          <div className="relative">
            <MarkdownRenderer content={msg.content} />
            {isStreamingThis && (
              <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-primary animate-pulse" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
