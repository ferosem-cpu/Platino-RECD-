"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ROLE_KEY } from "@recd/shared";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

/**
 * Minimal typing for the Web Speech API's SpeechRecognition - not in TypeScript's default DOM
 * lib (still not a W3C standard, only ever shipped under a webkit-prefixed global), so this
 * declares just the surface the mic button actually uses rather than pulling in a third-party
 * types package for a handful of members.
 */
interface SpeechRecognitionResultLike {
  [index: number]: { transcript: string };
}
interface SpeechRecognitionEventLike extends Event {
  results: { [index: number]: SpeechRecognitionResultLike; length: number };
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Chrome/Edge only expose this under the webkit-prefixed name; Firefox and most Safari
 * versions don't implement it at all - callers must treat a null return as "no mic button". */
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Compact markdown rendering for the assistant's replies (tables, bold, lists) - sized for
 * the ~300px-wide chat bubble, not the full-page prose the default browser table/list styles
 * assume. User messages stay plain text; only the assistant writes markdown.
 *
 * Each renderer destructures `node` out before spreading the rest - react-markdown passes the
 * mdast AST node as a prop to custom components, and spreading it straight onto a DOM element
 * leaks it as a literal node="[object Object]" attribute.
 */
const markdownComponents: Components = {
  p: ({ node, ...props }) => <p className="mb-1.5 last:mb-0" {...props} />,
  ul: ({ node, ...props }) => <ul className="mb-1.5 ml-4 list-disc space-y-0.5" {...props} />,
  ol: ({ node, ...props }) => <ol className="mb-1.5 ml-4 list-decimal space-y-0.5" {...props} />,
  li: ({ node, ...props }) => <li {...props} />,
  strong: ({ node, ...props }) => <strong className="font-semibold" {...props} />,
  code: ({ node, ...props }) => <code className="rounded bg-gray-200 px-1 py-0.5 font-mono text-[11px]" {...props} />,
  table: ({ node, ...props }) => (
    <div className="mb-1.5 -mx-1 overflow-x-auto">
      <table className="border-collapse text-[11px]" {...props} />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th className="border border-gray-300 bg-gray-50 px-1.5 py-1 text-left font-semibold whitespace-nowrap" {...props} />
  ),
  td: ({ node, ...props }) => <td className="border border-gray-300 px-1.5 py-1 align-top" {...props} />,
};

interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredMessage {
  role: "user" | "assistant" | "tool";
  content?: string;
  toolCallId?: string;
  toolName?: string;
}

interface PendingActionContent {
  status: "pending_confirmation" | "confirmed" | "rejected";
  actionId: string;
  preview?: Record<string, unknown>;
  resultId?: string | null;
}

/** A tool-result message is a proposed write action (create_order / create_product) if its
 * JSON content has an actionId - regardless of which write tool produced it, so a future
 * write tool needs no frontend changes here. */
function parsePendingAction(m: StoredMessage): PendingActionContent | null {
  if (m.role !== "tool" || !m.content) return null;
  try {
    const parsed = JSON.parse(m.content);
    return parsed && typeof parsed === "object" && parsed.actionId ? (parsed as PendingActionContent) : null;
  } catch {
    return null;
  }
}

function labelizeKey(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

export default function AgentChatBubble() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [visible, setVisible] = useState(false);
  const [checkedVisibility, setCheckedVisibility] = useState(false);
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvingActionId, setResolvingActionId] = useState<string | null>(null);

  const [micSupported, setMicSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isCustomer = user?.role.key === ROLE_KEY.CUSTOMER;

  // Feature-detected client-side only (no server-side equivalent - purely a browser API),
  // so the mic button simply doesn't render on browsers that don't implement it.
  useEffect(() => {
    setMicSupported(!!getSpeechRecognitionCtor());
  }, []);

  // Stop any in-flight recognition if the component unmounts mid-listen (e.g. user navigates
  // away with the panel open) rather than leaving the mic silently listening in the background.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "en-IN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;
      setInput((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  // Visibility: current user's role must be in the Super-Admin-configured allowlist.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setVisible(false);
      setCheckedVisibility(true);
      return;
    }
    api<{ agentVisibleRoleKeys?: string[] }>("/settings")
      .then((data) => {
        const roleKeys = data.agentVisibleRoleKeys ?? [];
        setVisible(roleKeys.includes(user.role.key));
      })
      .catch(() => setVisible(false))
      .finally(() => setCheckedVisibility(true));
  }, [authLoading, user]);

  const loadConversations = useCallback(async () => {
    const data = await api<{ conversations: ConversationSummary[] }>("/agent/conversations");
    setConversations(data.conversations);
    return data.conversations;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const data = await api<{ id: string; messages: StoredMessage[] }>(`/agent/conversations/${id}`);
    setActiveId(data.id);
    setMessages(data.messages ?? []);
  }, []);

  async function ensureConversation(): Promise<string> {
    if (activeId) return activeId;
    const list = conversations.length > 0 ? conversations : await loadConversations();
    if (list.length > 0) {
      await loadConversation(list[0].id);
      return list[0].id;
    }
    const created = await api<{ id: string }>("/agent/conversations", { method: "POST", body: JSON.stringify({}) });
    setActiveId(created.id);
    setMessages([]);
    setConversations([{ id: created.id, title: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
    return created.id;
  }

  async function startNewConversation() {
    const created = await api<{ id: string }>("/agent/conversations", { method: "POST", body: JSON.stringify({}) });
    setActiveId(created.id);
    setMessages([]);
    setShowHistory(false);
    loadConversations();
  }

  async function openPanel() {
    setOpen(true);
    if (!activeId) {
      try {
        await ensureConversation();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);
    try {
      const id = await ensureConversation();
      const result = await api<{ reply: string; messages: StoredMessage[] }>(`/agent/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      setMessages(result.messages ?? []);
      loadConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  /** Copies a response's raw markdown text. Falls back to the old execCommand path for
   * non-secure contexts / browsers without the async Clipboard API. */
  async function copyMessage(text: string, index: number) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((cur) => (cur === index ? null : cur)), 1500);
    } catch {
      // Clipboard permission denied/unsupported - no-op, the button just won't show "Copied".
    }
  }

  async function resolveAction(actionId: string, outcome: "confirm" | "reject") {
    if (!activeId || resolvingActionId) return;
    setResolvingActionId(actionId);
    setError(null);
    try {
      const result = await api<{ messages: StoredMessage[] }>(
        `/agent/conversations/${activeId}/actions/${actionId}/${outcome}`,
        { method: "POST" },
      );
      setMessages(result.messages ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingActionId(null);
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  // Links to a page within this app (e.g. /orders/{id}) navigate client-side and close the
  // panel so the user actually sees the page; anything else (shared-document links, etc.)
  // behaves like a normal external link, opened in a new tab.
  const markdownComponentsWithLinks: Components = {
    ...markdownComponents,
    a: ({ node, href, children, ...props }) => {
      if (href && href.startsWith("/")) {
        return (
          <a
            {...props}
            href={href}
            className="underline text-blue-600"
            onClick={(e) => {
              e.preventDefault();
              setOpen(false);
              router.push(href);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a {...props} href={href} className="underline text-blue-600" target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };

  if (!checkedVisibility || !visible) return null;

  // Render user turns, assistant turns that said something, and any tool-result that's a
  // proposed write action (confirm card) - other tool-call-only/raw-result turns stay hidden
  // as implementation detail.
  const visibleMessages = messages.filter(
    (m) => ((m.role === "user" || m.role === "assistant") && m.content) || parsePendingAction(m),
  );

  return (
    <>
      {!open && (
        <button
          onClick={openPanel}
          className="fixed bottom-5 right-5 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-white text-xl print:hidden"
          style={{ backgroundColor: "var(--theme-primary, #F58220)" }}
          aria-label="Open assistant"
        >
          💬
        </button>
      )}

      {open && (
        <div
          className={`fixed z-50 bg-white shadow-2xl flex flex-col overflow-hidden border border-gray-100 print:hidden ${
            maximized
              ? "inset-4 rounded-2xl"
              : "bottom-5 right-5 w-[360px] max-w-[calc(100vw-2.5rem)] h-[520px] max-h-[calc(100vh-3rem)] rounded-2xl"
          }`}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <span className="font-semibold text-sm">Assistant</span>
            <div className="flex items-center gap-3 text-gray-400">
              <button onClick={() => setShowHistory((v) => !v)} className="text-xs hover:text-gray-700" title="History">
                History
              </button>
              <button onClick={startNewConversation} className="text-xs hover:text-gray-700" title="New chat">
                + New
              </button>
              <button
                onClick={() => setMaximized((v) => !v)}
                className="hover:text-gray-700"
                aria-label={maximized ? "Minimize" : "Maximize"}
                title={maximized ? "Minimize" : "Maximize"}
              >
                {maximized ? "🗗" : "🗖"}
              </button>
              <button onClick={() => setOpen(false)} className="hover:text-gray-700" aria-label="Close">
                ✕
              </button>
            </div>
          </div>

          {showHistory && (
            <div className="border-b border-gray-100 max-h-40 overflow-y-auto">
              {conversations.length === 0 ? (
                <p className="text-xs text-gray-400 px-4 py-2">No past conversations.</p>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      loadConversation(c.id);
                      setShowHistory(false);
                    }}
                    className={`block w-full text-left px-4 py-2 text-xs hover:bg-gray-50 ${c.id === activeId ? "bg-gray-50 font-medium" : ""}`}
                  >
                    {c.title || "New conversation"}
                  </button>
                ))
              )}
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {visibleMessages.length === 0 && !sending && (
              <p className="text-xs text-gray-400">
                {isCustomer
                  ? "Ask me about the status of your sites."
                  : "Ask me anything - I can search shared documents for you."}
              </p>
            )}
            {visibleMessages.map((m, i) => {
              const action = parsePendingAction(m);
              if (action) {
                const entries = action.preview
                  ? Object.entries(action.preview).filter(([, v]) => v !== null && v !== undefined && v !== "")
                  : [];
                return (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-[90%] w-full rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm">
                      <p className="text-xs font-medium text-amber-700 mb-2">
                        {action.status === "pending_confirmation" && "Proposed - needs your confirmation"}
                        {action.status === "confirmed" && "✅ Confirmed and created"}
                        {action.status === "rejected" && "✕ Rejected"}
                      </p>
                      {entries.length > 0 && (
                        <dl className="space-y-0.5 mb-2">
                          {entries.map(([k, v]) => (
                            <div key={k} className="flex justify-between gap-3 text-xs">
                              <dt className="text-gray-500">{labelizeKey(k)}</dt>
                              <dd className="text-gray-800 font-medium text-right">{String(v)}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {action.status === "pending_confirmation" && (
                        <div className="flex gap-2 pt-1">
                          <button
                            className="flex-1 rounded-lg bg-gray-900 text-white text-xs py-1.5 disabled:opacity-50"
                            disabled={resolvingActionId === action.actionId}
                            onClick={() => resolveAction(action.actionId, "confirm")}
                          >
                            {resolvingActionId === action.actionId ? "Working…" : "Confirm"}
                          </button>
                          <button
                            className="flex-1 rounded-lg border border-gray-300 text-gray-600 text-xs py-1.5 disabled:opacity-50"
                            disabled={resolvingActionId === action.actionId}
                            onClick={() => resolveAction(action.actionId, "reject")}
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[85%]">
                    <div
                      className={`rounded-2xl px-3 py-2 text-sm ${
                        m.role === "user" ? "bg-gray-900 text-white whitespace-pre-wrap" : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {m.role === "assistant" ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponentsWithLinks}>
                          {m.content}
                        </ReactMarkdown>
                      ) : (
                        m.content
                      )}
                    </div>
                    {m.role === "assistant" && m.content && (
                      <button
                        onClick={() => copyMessage(m.content!, i)}
                        className="mt-1 flex items-center gap-1 pl-1 text-[11px] text-gray-400 hover:text-gray-600"
                        title="Copy response"
                      >
                        {copiedIndex === i ? (
                          <>✓ Copied</>
                        ) : (
                          <>⧉ Copy</>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {sending && (
              <div className="flex justify-start">
                <div className="bg-gray-100 text-gray-400 rounded-2xl px-3 py-2 text-sm">Thinking…</div>
              </div>
            )}
            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>

          <div className="border-t border-gray-100 p-3 flex gap-2">
            <input
              className="field flex-1 text-sm"
              placeholder={listening ? "Listening…" : "Type a message…"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={sending}
            />
            {micSupported && (
              <button
                type="button"
                onClick={toggleMic}
                disabled={sending}
                className={`px-3 py-2 rounded-lg text-sm border disabled:opacity-50 ${
                  listening ? "bg-red-500 border-red-500 text-white animate-pulse" : "border-gray-300 text-gray-500 hover:text-gray-700"
                }`}
                aria-label={listening ? "Stop voice input" : "Speak instead of typing"}
                title={listening ? "Stop voice input" : "Speak instead of typing"}
              >
                🎤
              </button>
            )}
            <button className="btn-primary px-3 py-2 text-sm" onClick={send} disabled={sending || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
