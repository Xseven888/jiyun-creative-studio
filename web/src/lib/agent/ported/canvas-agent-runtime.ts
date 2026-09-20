import { nanoid } from "nanoid";

import { requestTextToolTurn, type ResponseInputMessage, type ResponseFunctionTool } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";
import { buildCanvasAgentSkillPrompt } from "./canvas-agent-skills";
import { buildCanvasAgentContext } from "./canvas-agent-context";
import { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, canvasAgentActionLabel, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";
import type { CanvasAgentContext, CanvasAgentProtocolMessage, CanvasAgentState } from "./types";

const MAX_AGENT_STEPS = 12;

export type RunCanvasAgentInput = {
    config: AiConfig;
    initialState: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
    userText: string;
    activeSkillContents?: Array<{ id: string; source: "system" | "user"; name: string; content: string; hasFiles?: boolean }>;
    getContext: (state: CanvasAgentState) => CanvasAgentContext;
    executeAction: (action: CanvasAgentAction, signal?: AbortSignal) => Promise<CanvasAgentToolResult>;
    onEvent?: (event: { status: "thinking" | "running" | "waiting" | "success" | "error"; label: string }) => void;
    signal?: AbortSignal;
};

export type RunCanvasAgentResult = { reply: string; state: CanvasAgentState; protocolMessages: CanvasAgentProtocolMessage[] };

export function createCanvasAgentState(): CanvasAgentState {
    return { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
}

export async function runCanvasAgent(input: RunCanvasAgentInput): Promise<RunCanvasAgentResult> {
    let state = input.initialState;
    const messages = protocolToRequestMessages(input.protocolMessages);
    messages.push({ role: "user", content: input.userText });
    const protocolMessages = [...input.protocolMessages, { role: "user" as const, content: input.userText }];
    const skillText = input.activeSkillContents?.map((skill) => `【完整 Skill：${skill.name}】\n${skill.content}`).join("\n\n");

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        throwIfAborted(input.signal);
        input.onEvent?.({ status: "thinking", label: step ? "正在根据画布结果继续" : "正在理解画布和创作目标" });
        const context = input.getContext(state);
        const systemPrompt = buildSystemPrompt(input.config, input.userText, context, skillText);
        const turn = await requestTextToolTurn(input.config, { systemPrompt, messages, tools: CANVAS_AGENT_TOOLS as ResponseFunctionTool[], signal: input.signal });
        if (!turn.toolCalls.length) {
            const reply = turn.content.trim() || "我已经读取当前画布。请告诉我下一步要继续完善哪一部分。";
            protocolMessages.push({ role: "assistant", content: reply });
            return { reply, state, protocolMessages };
        }

        const assistantCalls = turn.toolCalls.map((call) => ({ id: call.id || nanoid(), name: call.function.name, arguments: parseArguments(call.function.arguments) }));
        messages.push(...assistantCalls.map((call) => ({ type: "function_call" as const, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })));
        protocolMessages.push({ role: "assistant", content: turn.content || undefined, toolCalls: assistantCalls });
        for (const call of assistantCalls) {
            throwIfAborted(input.signal);
            let result: CanvasAgentToolResult;
            try {
                const action = normalizeCanvasAgentAction(call.name, call.arguments, call.id);
                input.onEvent?.({ status: "running", label: canvasAgentActionLabel(action) });
                result = await input.executeAction(action, input.signal);
                if (action.name === "set_agent_state" && result.ok) state = applyAgentState(state, action.arguments);
                else state = applyTaskResult(state, result);
            } catch (error) {
                result = { ok: false, code: "tool_execution_failed", message: error instanceof Error ? error.message : "工具执行失败" };
            }
            const content = JSON.stringify(result);
            messages.push({ role: "tool", tool_call_id: call.id, content });
            protocolMessages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
        }
    }
    const reply = "本轮已达到安全操作步数上限，当前已完成的节点和任务都已保存。你可以让我继续下一步。";
    return { reply, state, protocolMessages: [...protocolMessages, { role: "assistant", content: reply }] };
}

function buildSystemPrompt(config: AiConfig, userText: string, context: CanvasAgentContext, activeSkillContents?: string) {
    const prompt = buildCanvasAgentSkillPrompt(context.agentState.phase, userText, context, activeSkillContents);
    return [config.systemPrompt.trim(), prompt, "\n需要修改画布时必须调用工具并依据工具结果回答；不得声称未执行的操作已完成。所有节点 ID 必须来自当前真实画布。回复使用中文。"].filter(Boolean).join("\n\n");
}

function protocolToRequestMessages(messages: CanvasAgentProtocolMessage[]): ResponseInputMessage[] {
    return messages.map((message) => {
        if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
        if (message.role === "assistant" && message.toolCalls?.length) return { role: "assistant", content: message.content || "" };
        return { role: message.role, content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "[媒体引用]").join("\n") };
    });
}

function parseArguments(value: string) {
    try { return JSON.parse(value || "{}"); } catch { throw new Error("工具参数不是合法 JSON"); }
}

function applyAgentState(state: CanvasAgentState, patch: Record<string, unknown>): CanvasAgentState {
    return { ...state, phase: typeof patch.phase === "string" ? patch.phase as CanvasAgentState["phase"] : state.phase, brief: typeof patch.brief === "string" ? patch.brief : state.brief, targetDurationSeconds: typeof patch.targetDurationSeconds === "number" ? patch.targetDurationSeconds : state.targetDurationSeconds, approvedPlan: typeof patch.approvedPlan === "string" ? patch.approvedPlan : state.approvedPlan, approvedNodeIds: Array.isArray(patch.approvedNodeIds) ? patch.approvedNodeIds.filter((id): id is string => typeof id === "string") : state.approvedNodeIds, referenceNodeIds: Array.isArray(patch.referenceNodeIds) ? patch.referenceNodeIds.filter((id): id is string => typeof id === "string") : state.referenceNodeIds };
}

function applyTaskResult(state: CanvasAgentState, result: CanvasAgentToolResult) {
    const taskId = typeof result.taskId === "string" ? result.taskId : "";
    if (!taskId) return state;
    const completed = result.status === "success" || result.status === "completed";
    const terminal = completed || result.status === "error" || result.status === "failed";
    return { ...state, pendingTaskIds: terminal ? state.pendingTaskIds.filter((id) => id !== taskId) : [...new Set([...state.pendingTaskIds, taskId])], completedTaskIds: completed ? [...new Set([...state.completedTaskIds, taskId])] : state.completedTaskIds };
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Agent 已停止", "AbortError");
}
