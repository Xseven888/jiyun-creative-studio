import { nanoid } from "nanoid";

import { requestTextToolTurn, type AiTextMessage, type ResponseFunctionTool, type ResponseInputMessage } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

const MAX_STEPS = 8;
const ALLOWED_OPS = new Set<CanvasAgentOp["type"]>(["add_node", "update_node", "delete_node", "delete_connections", "connect_nodes", "set_viewport", "select_nodes", "run_generation"]);

const APPLY_CANVAS_OPS_TOOL: ResponseFunctionTool = {
    type: "function",
    function: {
        name: "apply_canvas_ops",
        description: "Apply one or more validated operations to the active canvas. Use node IDs from the current canvas state. To generate media or text, first add or update a config node, then run_generation on that node.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                ops: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            type: { type: "string", enum: [...ALLOWED_OPS] },
                            id: { type: "string" },
                            ids: { type: "array", items: { type: "string" } },
                            nodeType: { type: "string", enum: Object.values(CanvasNodeType) },
                            title: { type: "string" },
                            position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
                            x: { type: "number" },
                            y: { type: "number" },
                            width: { type: "number" },
                            height: { type: "number" },
                            patch: { type: "object", additionalProperties: true },
                            metadata: { type: "object", additionalProperties: true },
                            fromNodeId: { type: "string" },
                            toNodeId: { type: "string" },
                            all: { type: "boolean" },
                            viewport: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, k: { type: "number" } }, required: ["x", "y", "k"] },
                            mode: { type: "string", enum: ["text", "image", "video", "audio"] },
                            prompt: { type: "string" },
                            nodeId: { type: "string" },
                        },
                        required: ["type"],
                    },
                },
            },
            required: ["ops"],
        },
    },
};

export type BrowserAgentHistoryMessage = Pick<AiTextMessage, "role" | "content">;

export async function runBrowserAgent(input: {
    config: AiConfig;
    prompt: string;
    history: BrowserAgentHistoryMessage[];
    getSnapshot: () => CanvasAgentSnapshot | null;
    applyOps: (ops: CanvasAgentOp[]) => CanvasAgentSnapshot;
    onTool: (ops: CanvasAgentOp[]) => void;
    signal?: AbortSignal;
}) {
    const messages: ResponseInputMessage[] = [...input.history, { role: "user", content: input.prompt }];

    for (let step = 0; step < MAX_STEPS; step++) {
        throwIfAborted(input.signal);
        const snapshot = input.getSnapshot();
        if (!snapshot) throw new Error("请先打开一个画布，再使用内置 Agent");
        const turn = await requestTextToolTurn(input.config, {
            systemPrompt: buildSystemPrompt(snapshot),
            messages,
            tools: [APPLY_CANVAS_OPS_TOOL],
            signal: input.signal,
        });
        if (!turn.toolCalls.length) return turn.content.trim() || "已读取当前画布，请告诉我下一步要做什么。";

        for (const toolCall of turn.toolCalls) {
            const callId = toolCall.id || nanoid();
            messages.push({ type: "function_call", call_id: callId, name: toolCall.function.name, arguments: toolCall.function.arguments || "{}", ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}) });
            const result = executeTool(toolCall.function.name, toolCall.function.arguments, input.applyOps, input.onTool);
            messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify(result) });
        }
    }
    return "本轮已达到画布操作步数上限，已完成的操作均已保存。你可以让我继续。";
}

function executeTool(name: string, rawArguments: string, applyOps: (ops: CanvasAgentOp[]) => CanvasAgentSnapshot, onTool: (ops: CanvasAgentOp[]) => void) {
    if (name !== APPLY_CANVAS_OPS_TOOL.function.name) return { ok: false, error: "不支持的工具" };
    let value: unknown;
    try {
        value = JSON.parse(rawArguments || "{}");
    } catch {
        return { ok: false, error: "工具参数不是合法 JSON" };
    }
    const rawOps = value && typeof value === "object" && Array.isArray((value as { ops?: unknown }).ops) ? (value as { ops: unknown[] }).ops : [];
    if (!rawOps.length) return { ok: false, error: "每次必须提交至少一个画布操作" };
    const ops = rawOps.filter((op): op is CanvasAgentOp => isValidOp(op));
    if (ops.length !== rawOps.length) return { ok: false, error: "包含不完整或不支持的画布操作" };
    const snapshot = applyOps(ops);
    onTool(ops);
    return { ok: true, nodeCount: snapshot.nodes.length, connectionCount: snapshot.connections.length, selectedNodeIds: snapshot.selectedNodeIds };
}

function isValidOp(value: unknown): value is CanvasAgentOp {
    if (!value || typeof value !== "object") return false;
    const op = value as Record<string, unknown>;
    if (!ALLOWED_OPS.has(op.type as CanvasAgentOp["type"])) return false;
    if (op.type === "update_node") {
        const patch = op.patch as Record<string, unknown> | undefined;
        return nonEmptyString(op.id) && Boolean((patch && !hasOwn(patch, "id") && !hasOwn(patch, "type")) || recordValue(op.metadata));
    }
    if (op.type === "run_generation") return nonEmptyString(op.nodeId);
    if (op.type === "connect_nodes") return nonEmptyString(op.fromNodeId) && nonEmptyString(op.toNodeId) && op.fromNodeId !== op.toNodeId;
    if (op.type === "select_nodes") return Array.isArray(op.ids) && op.ids.every(nonEmptyString);
    if (op.type === "set_viewport") {
        const viewport = op.viewport as Record<string, unknown> | undefined;
        return Boolean(viewport && finiteNumber(viewport.x) && finiteNumber(viewport.y) && finiteNumber(viewport.k) && Number(viewport.k) > 0);
    }
    if (op.type === "add_node" && op.position != null) {
        const position = op.position as Record<string, unknown>;
        return finiteNumber(position.x) && finiteNumber(position.y);
    }
    if (op.type === "delete_node") return nonEmptyString(op.id) || (Array.isArray(op.ids) && op.ids.length > 0 && op.ids.every(nonEmptyString)) || nonEmptyString(op.nodeType);
    if (op.type === "delete_connections") return op.all === true || nonEmptyString(op.id) || (Array.isArray(op.ids) && op.ids.length > 0 && op.ids.every(nonEmptyString));
    return true;
}

function recordValue(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(value: object, key: string) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim());
}

function finiteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function buildSystemPrompt(snapshot: CanvasAgentSnapshot) {
    return `你是无限画布内置 Agent。你直接操作用户当前打开的画布，不需要本地 Codex 或 MCP。

规则：
1. 需要修改画布时必须调用 apply_canvas_ops，不得只描述“已经完成”。
2. 只使用当前画布中真实存在的节点 ID。新增节点需要被后续操作引用时，请自行提供唯一 id。
3. 文本内容写入 text 节点的 metadata.content。
4. 生成图片、视频、音频或文本时，创建 config 节点并设置 metadata.generationMode、metadata.composerContent 和必要配置，再调用 run_generation。run_generation 的 nodeId 必须是 config 节点 ID。
5. source 节点到 config 节点的引用用 connect_nodes 表达。不要伪造生成结果。
6. 用户只咨询或分析时直接回答，不调用工具。
7. 回复使用中文，简洁说明实际完成的结果。

当前画布状态：
${JSON.stringify(summarizeSnapshot(snapshot))}`;
}

function summarizeSnapshot(snapshot: CanvasAgentSnapshot) {
    return {
        projectId: snapshot.projectId,
        title: snapshot.title,
        selectedNodeIds: snapshot.selectedNodeIds,
        viewport: snapshot.viewport,
        nodes: snapshot.nodes.map((node) => ({
            id: node.id,
            type: node.type,
            title: node.title,
            position: node.position,
            width: node.width,
            height: node.height,
            metadata: {
                content: node.type === CanvasNodeType.Text ? node.metadata?.content?.slice(0, 4000) : undefined,
                hasContent: node.type !== CanvasNodeType.Text ? Boolean(node.metadata?.content) : undefined,
                prompt: node.metadata?.prompt?.slice(0, 4000),
                composerContent: node.metadata?.composerContent?.slice(0, 4000),
                status: node.metadata?.status,
                generationMode: node.metadata?.generationMode,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                count: node.metadata?.count,
                seconds: node.metadata?.seconds,
                groupId: node.metadata?.groupId,
            },
        })),
        connections: snapshot.connections,
    };
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("请求已停止", "AbortError");
}
