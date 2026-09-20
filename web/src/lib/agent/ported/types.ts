import type { CanvasNodeTypeId, CanvasConnection } from "@/types/canvas";

export type CanvasAgentPhase = "intake" | "concept" | "script" | "breakdown" | "references" | "storyboard" | "video" | "audio" | "review" | "complete";
export type CanvasAgentState = { phase: CanvasAgentPhase; brief?: string; targetDurationSeconds?: number; approvedPlan?: string; approvedNodeIds: string[]; referenceNodeIds: string[]; pendingTaskIds: string[]; completedTaskIds: string[] };
export type CanvasAgentContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
export type CanvasAgentToolCall = { id: string; name: string; arguments: Record<string, unknown>; argumentsError?: string };
export type CanvasAgentToolMode = "native" | "structured-json" | "prompt-json";
export type CanvasAgentJsonFallbackMode = "structured-json" | "prompt-json";
export type CanvasAgentProtocolMessage =
    | { role: "user" | "system"; content: CanvasAgentContent }
    | { role: "assistant"; content?: string; reasoningContent?: string; responseItems?: unknown[]; toolCalls?: CanvasAgentToolCall[] }
    | { role: "tool"; content: string; toolCallId: string; name: string };
export type CanvasAgentContext = {
    project: { id: string; title: string; nodeCount: number; connectionCount: number };
    agentState: CanvasAgentState;
    selectedNodeIds: string[];
    nodes: Array<{ id: string; type: CanvasNodeTypeId; title: string; text?: string; mediaUrl?: string; hasMedia?: boolean; status?: string; prompt?: string; model?: string; size?: string; seconds?: string; generateAudio?: string; taskId?: string; error?: string; groupId?: string }>;
    connections: CanvasConnection[];
    generation: Record<string, unknown>;
    tasks: Array<{ nodeId: string; type: CanvasNodeTypeId; status: string; taskId: string; progress?: number; error?: string }>;
};
