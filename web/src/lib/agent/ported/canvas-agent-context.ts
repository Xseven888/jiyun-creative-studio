import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { CanvasAgentContext, CanvasAgentState } from "./types";

const MAX_CONTEXT_NODES = 120;
const MAX_TEXT_LENGTH = 4000;

export function buildCanvasAgentContext(input: { projectId: string; projectTitle: string; nodes: CanvasNodeData[]; connections: CanvasConnection[]; selectedNodeIds: Iterable<string>; config: AiConfig; autoGenerateMedia: boolean; agentState: CanvasAgentState }): CanvasAgentContext {
    const selectedNodeIds = Array.from(input.selectedNodeIds);
    const prioritizedIds = new Set([...selectedNodeIds, ...input.agentState.approvedNodeIds, ...input.agentState.referenceNodeIds]);
    input.connections.forEach((connection) => {
        if (prioritizedIds.has(connection.fromNodeId) || prioritizedIds.has(connection.toNodeId)) {
            prioritizedIds.add(connection.fromNodeId);
            prioritizedIds.add(connection.toNodeId);
        }
    });
    input.nodes.forEach((node) => {
        if (node.metadata?.status === "loading" || node.metadata?.status === "error") prioritizedIds.add(node.id);
    });
    const orderedNodes = [...input.nodes.filter((node) => prioritizedIds.has(node.id)), ...input.nodes.filter((node) => !prioritizedIds.has(node.id))].slice(0, MAX_CONTEXT_NODES);
    const includedIds = new Set(orderedNodes.map((node) => node.id));
    return {
        project: { id: input.projectId, title: input.projectTitle, nodeCount: input.nodes.length, connectionCount: input.connections.length },
        agentState: input.agentState,
        selectedNodeIds,
        nodes: orderedNodes.map(summarizeNode),
        connections: input.connections.filter((connection) => includedIds.has(connection.fromNodeId) && includedIds.has(connection.toNodeId)),
        generation: { autoGenerateMedia: input.autoGenerateMedia, textModel: input.config.textModel || input.config.model, imageModel: input.config.imageModel || input.config.model, videoModel: input.config.videoModel || input.config.model, audioModel: input.config.audioModel, imageQuality: input.config.quality, imageSize: input.config.size, videoQuality: input.config.vquality, videoSize: input.config.size, imageCount: input.config.canvasImageCount || input.config.count, videoSeconds: input.config.videoSeconds, videoGenerateAudio: input.config.videoGenerateAudio },
        tasks: orderedNodes.flatMap((node) => {
            const taskId = mediaTaskId(node);
            return taskId ? [{ nodeId: node.id, type: node.type, status: node.metadata?.status || "idle", taskId, error: node.metadata?.errorDetails }] : [];
        }),
    };
}

export function serializeCanvasAgentContext(context: CanvasAgentContext) {
    return JSON.stringify(context);
}

function summarizeNode(node: CanvasNodeData) {
    const content = node.metadata?.content || "";
    const isText = node.type === CanvasNodeType.Text;
    return { id: node.id, type: node.type, title: node.title, text: isText && content ? content.slice(0, MAX_TEXT_LENGTH) : undefined, mediaUrl: !isText && content && !content.startsWith("data:") ? content : undefined, hasMedia: !isText ? Boolean(content) : undefined, status: node.metadata?.status, prompt: node.metadata?.prompt?.slice(0, MAX_TEXT_LENGTH), model: node.metadata?.model, size: node.metadata?.size, seconds: node.metadata?.seconds, generateAudio: node.metadata?.generateAudio, taskId: mediaTaskId(node) || undefined, error: node.metadata?.errorDetails, groupId: node.metadata?.groupId };
}

function mediaTaskId(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Video ? node.metadata?.videoTaskId || "" : "";
}
