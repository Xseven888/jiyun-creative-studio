import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { Bot, LoaderCircle, PanelRightClose, Sparkles } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { createCanvasAgentState, runCanvasAgent } from "@/lib/agent/ported/canvas-agent-runtime";
import { buildCanvasAgentContext } from "@/lib/agent/ported/canvas-agent-context";
import type { CanvasAgentAction, CanvasAgentToolResult } from "@/lib/agent/ported/canvas-agent-tools";
import type { CanvasAgentProtocolMessage, CanvasAgentState } from "@/lib/agent/ported/types";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";
import { useAgentStore, type AgentChatItem } from "@/stores/use-agent-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { AgentChatMessage } from "./agent-chat-message";
import { AgentChatPromptInput } from "./agent-chat-prompt-input";

export function BrowserAgentPanel({ theme, onClose }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onClose: () => void }) {
    const { t } = useTranslation();
    const config = useEffectiveConfig();
    const isConfigReady = useConfigStore((state) => state.isAiConfigReady(config, config.textModel || config.model));
    const hasCanvas = useAgentStore((state) => Boolean(state.canvasContext));
    const projectId = useAgentStore((state) => state.canvasContext?.snapshot.projectId || "");
    const [prompt, setPrompt] = useState("");
    const [messages, setMessages] = useState<AgentChatItem[]>([]);
    const [sending, setSending] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(true);
    const agentStateRef = useRef<CanvasAgentState>(createCanvasAgentState());
    const protocolRef = useRef<CanvasAgentProtocolMessage[]>([]);
    const addMessage = (item: AgentChatItem) => setMessages((current) => [...current, item]);
    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [messages, sending]);
    useEffect(() => {
        return () => {
            mountedRef.current = false;
            abortRef.current?.abort();
        };
    }, []);
    useEffect(() => {
        setMessages([]);
        agentStateRef.current = createCanvasAgentState();
        protocolRef.current = [];
    }, [projectId]);

    const send = async () => {
        const text = prompt.trim();
        if (!text || sending || !hasCanvas) return;
        if (!isConfigReady) {
            useConfigStore.getState().openConfigDialog(false, "channels");
            return;
        }
        const userMessage: AgentChatItem = { id: `browser-user-${Date.now()}`, role: "user", text };
        setPrompt("");
        setMessages((current) => [...current, userMessage]);
        setSending(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const reply = await runCanvasAgent({
                config,
                userText: text,
                initialState: agentStateRef.current,
                protocolMessages: protocolRef.current,
                getContext: () => buildAgentContext(),
                executeAction: executeAction,
                signal: controller.signal,
            });
            agentStateRef.current = reply.state;
            protocolRef.current = reply.protocolMessages;
            if (mountedRef.current) addMessage({ id: `browser-assistant-${Date.now()}`, role: "assistant", text: reply.reply });
        } catch (error) {
            if (!mountedRef.current) return;
            if ((error as Error)?.name !== "AbortError") {
                const message = error instanceof Error ? error.message : t("agent.browser.requestFailed");
                addMessage({ id: `browser-error-${Date.now()}`, role: "error", text: message });
            } else {
                addMessage({ id: `browser-stopped-${Date.now()}`, role: "system", text: t("agent.browser.stopped") });
            }
        } finally {
            abortRef.current = null;
            if (mountedRef.current) setSending(false);
        }
    };

    const buildAgentContext = () => {
        const context = useAgentStore.getState().canvasContext;
        if (!context) throw new Error(t("agent.browser.canvasRequired"));
        return buildCanvasAgentContext({ projectId: context.snapshot.projectId, projectTitle: context.snapshot.title, nodes: context.snapshot.nodes, connections: context.snapshot.connections, selectedNodeIds: context.snapshot.selectedNodeIds, config, autoGenerateMedia: true, agentState: agentStateRef.current });
    };

    const executeAction = async (action: CanvasAgentAction): Promise<CanvasAgentToolResult> => {
        const canvas = useAgentStore.getState().canvasContext;
        if (!canvas) return { ok: false, code: "canvas_required", message: t("agent.browser.canvasRequired") };
        const snapshot = canvas.snapshot;
        const args = action.arguments;
        const stringValue = (key: string) => typeof args[key] === "string" ? String(args[key]).trim() : "";
        const stringValues = (key: string) => Array.isArray(args[key]) ? [...new Set((args[key] as unknown[]).filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))] : [];
        const getNode = (id: string) => snapshot.nodes.find((node) => node.id === id);
        const missing = (id: string): CanvasAgentToolResult => ({ ok: false, code: "node_not_found", message: `找不到节点 ${id}` });
        const ensureNodes = (ids: string[]) => ids.find((id) => !getNode(id)) || "";
        const nodeSummary = (node: NonNullable<ReturnType<typeof getNode>>) => ({ id: node.id, type: node.type, title: node.title, status: node.metadata?.status, prompt: node.metadata?.prompt, text: node.type === CanvasNodeType.Text ? node.metadata?.content?.slice(0, 4000) : undefined, hasMedia: node.type !== CanvasNodeType.Text ? Boolean(node.metadata?.content) : undefined, groupId: node.metadata?.groupId });
        const commit = (ops: Parameters<typeof canvas.applyOps>[0]) => canvas.applyOps(ops);
        if (action.name === "get_canvas_summary") return { ok: true, project: { id: snapshot.projectId, title: snapshot.title }, selectedNodeIds: snapshot.selectedNodeIds, nodes: snapshot.nodes.slice(0, 120).map(nodeSummary), connections: snapshot.connections.slice(0, 240) };
        if (action.name === "get_selected_nodes") return { ok: true, nodes: snapshot.nodes.filter((node) => snapshot.selectedNodeIds.includes(node.id)).map(nodeSummary) };
        if (action.name === "query_canvas_nodes") {
            const id = stringValue("nodeId");
            const keyword = stringValue("keyword").toLowerCase();
            const type = stringValue("type");
            const page = Math.max(1, Math.floor(Number(args.page) || 1));
            const pageSize = Math.max(1, Math.min(50, Math.floor(Number(args.pageSize) || 20)));
            const filtered = snapshot.nodes.filter((node) => (!id || node.id === id) && (!type || node.type === type) && (!keyword || `${node.title} ${node.metadata?.content || ""} ${node.metadata?.prompt || ""}`.toLowerCase().includes(keyword)));
            return { ok: true, items: filtered.slice((page - 1) * pageSize, page * pageSize).map(nodeSummary), total: filtered.length, page, pageSize };
        }
        if (["get_node", "get_generation_task", "get_media_task_status"].includes(action.name)) {
            const node = getNode(stringValue("nodeId"));
            if (!node) return missing(stringValue("nodeId"));
            return { ok: true, node: nodeSummary(node), taskId: node.metadata?.videoTaskId, status: node.metadata?.status, error: node.metadata?.errorDetails };
        }
        if (["get_upstream_nodes", "get_downstream_nodes", "get_connected_nodes"].includes(action.name)) {
            const nodeId = stringValue("nodeId");
            if (!getNode(nodeId)) return missing(nodeId);
            const upstreamIds = snapshot.connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
            const downstreamIds = snapshot.connections.filter((connection) => connection.fromNodeId === nodeId).map((connection) => connection.toNodeId);
            const upstream = snapshot.nodes.filter((node) => upstreamIds.includes(node.id)).map(nodeSummary);
            const downstream = snapshot.nodes.filter((node) => downstreamIds.includes(node.id)).map(nodeSummary);
            return action.name === "get_upstream_nodes" ? { ok: true, nodes: upstream } : action.name === "get_downstream_nodes" ? { ok: true, nodes: downstream } : { ok: true, upstream, downstream };
        }
        if (action.name === "get_generation_config") return { ok: true, generation: buildAgentContext().generation };
        if (action.name === "set_agent_state") {
            const ids = [...stringValues("approvedNodeIds"), ...stringValues("referenceNodeIds")];
            const missingId = ensureNodes(ids);
            return missingId ? missing(missingId) : { ok: true };
        }
        if (action.name === "create_text_node" || action.name === "create_primary_script_node") {
            const sourceIds = stringValues("sourceNodeIds");
            const missingId = ensureNodes(sourceIds);
            if (missingId) return missing(missingId);
            const right = Math.max(0, ...snapshot.nodes.map((node) => node.position.x + node.width)) + 96;
            const id = `text-${nanoid()}`;
            const result = commit([{ type: "add_node", id, nodeType: CanvasNodeType.Text, title: stringValue("title") || "文本", position: { x: right, y: Math.max(0, ...snapshot.nodes.map((node) => node.position.y)) }, metadata: { content: stringValue("content"), prompt: stringValue("content"), status: "success" } }, ...sourceIds.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: id }))]);
            return { ok: true, nodeId: id, node: result.nodes.find((node) => node.id === id) ? nodeSummary(result.nodes.find((node) => node.id === id)!) : undefined };
        }
        if (action.name === "update_text_node") {
            const id = stringValue("nodeId");
            const node = getNode(id);
            if (!node) return missing(id);
            if (node.type !== CanvasNodeType.Text) return { ok: false, code: "invalid_node_type", message: "只能修改文本节点" };
            const result = commit([{ type: "update_node", id, patch: { title: stringValue("title") || node.title }, metadata: stringValue("content") ? { content: stringValue("content"), prompt: stringValue("content"), status: "success" } : undefined }]);
            return { ok: true, nodeId: id, node: nodeSummary(result.nodes.find((item) => item.id === id)!) };
        }
        if (action.name === "update_node") {
            const id = stringValue("nodeId");
            if (!getNode(id)) return missing(id);
            commit([{ type: "update_node", id, patch: { title: stringValue("title") } }]);
            return { ok: true, nodeId: id };
        }
        if (action.name === "delete_node") {
            const id = stringValue("nodeId");
            if (!getNode(id)) return missing(id);
            commit([{ type: "delete_node", id }]);
            return { ok: true, deletedNodeIds: [id] };
        }
        if (action.name === "create_connection") {
            const fromNodeId = stringValue("fromNodeId");
            const toNodeId = stringValue("toNodeId");
            const missingId = ensureNodes([fromNodeId, toNodeId]);
            if (missingId) return missing(missingId);
            if (fromNodeId === toNodeId) return { ok: false, code: "self_connection", message: "节点不能连接到自身" };
            const result = commit([{ type: "connect_nodes", fromNodeId, toNodeId }]);
            return { ok: true, connectionCount: result.connections.length };
        }
        if (action.name === "delete_connection") {
            const id = stringValue("connectionId");
            if (!snapshot.connections.some((connection) => connection.id === id)) return { ok: false, code: "connection_not_found", message: `找不到连线 ${id}` };
            commit([{ type: "delete_connections", id }]);
            return { ok: true, deletedConnectionId: id };
        }
        if (action.name === "create_group") {
            const nodeIds = stringValues("nodeIds");
            const missingId = ensureNodes(nodeIds);
            if (missingId) return missing(missingId);
            const members = snapshot.nodes.filter((node) => nodeIds.includes(node.id) && node.type !== CanvasNodeType.Group);
            if (members.length < 2) return { ok: false, code: "invalid_group", message: "分组至少需要两个非分组节点" };
            const left = Math.min(...members.map((node) => node.position.x));
            const top = Math.min(...members.map((node) => node.position.y));
            const right = Math.max(...members.map((node) => node.position.x + node.width));
            const bottom = Math.max(...members.map((node) => node.position.y + node.height));
            const groupId = `group-${nanoid()}`;
            const padding = 24;
            const title = stringValue("title") || "分组";
            const ops: Parameters<typeof canvas.applyOps>[0] = [
                { type: "add_node", id: groupId, nodeType: CanvasNodeType.Group, title, position: { x: left - padding, y: top - 52 }, width: right - left + padding * 2, height: bottom - top + 76, metadata: { status: "idle" } },
                ...members.map((node) => ({ type: "update_node" as const, id: node.id, metadata: { groupId } })),
                { type: "select_nodes", ids: [groupId] },
            ];
            commit(ops);
            return { ok: true, groupId, nodeIds: members.map((node) => node.id) };
        }
        if (action.name === "arrange_nodes") {
            const requestedIds = stringValues("nodeIds");
            const targets = snapshot.nodes.filter((node) => (requestedIds.length ? requestedIds.includes(node.id) : node.type !== CanvasNodeType.Group && !node.metadata?.groupId));
            if (!targets.length) return { ok: true, arrangedNodeIds: [] };
            const columns = Math.max(1, Math.ceil(Math.sqrt(targets.length)));
            const gap = 48;
            const originX = Math.min(...targets.map((node) => node.position.x));
            const originY = Math.min(...targets.map((node) => node.position.y));
            const ops: Parameters<typeof canvas.applyOps>[0] = targets.map((node, index) => ({ type: "update_node" as const, id: node.id, patch: { position: { x: originX + (index % columns) * (node.width + gap), y: originY + Math.floor(index / columns) * (node.height + gap) } } }));
            commit(ops);
            return { ok: true, arrangedNodeIds: targets.map((node) => node.id) };
        }
        if (["generate_image", "edit_image", "generate_video", "generate_audio"].includes(action.name)) {
            const mode: "text" | "image" | "video" | "audio" = action.name === "generate_video" ? "video" : action.name === "generate_audio" ? "audio" : action.name === "generate_image" || action.name === "edit_image" ? "image" : "text";
            const sourceIds = stringValues("sourceNodeIds");
            const missingId = ensureNodes(sourceIds);
            if (missingId) return missing(missingId);
            const id = `config-${nanoid()}`;
            const metadata: CanvasNodeMetadata = {
                generationMode: mode,
                ...(mode === "image" ? { generationType: action.name === "edit_image" ? "edit" : "generation" } : {}),
                composerContent: stringValue("prompt"),
                prompt: stringValue("prompt"),
                model: mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : mode === "image" ? config.imageModel : config.textModel,
                size: stringValue("size") || config.size,
                count: typeof args.count === "number" ? args.count : mode === "image" ? Number(config.canvasImageCount) || 1 : 1,
                ...(mode === "video" ? { seconds: typeof args.seconds === "number" ? String(args.seconds) : config.videoSeconds, vquality: config.vquality, generateAudio: typeof args.generateAudio === "boolean" ? String(args.generateAudio) : config.videoGenerateAudio, watermark: config.videoWatermark, videoMode: config.videoMode } : {}),
                ...(mode === "audio" ? { audioVoice: stringValue("voice") || config.audioVoice, audioFormat: config.audioFormat, audioSpeed: config.audioSpeed, audioInstructions: stringValue("instructions") || config.audioInstructions } : {}),
                status: "idle",
            };
            commit([{ type: "add_node", id, nodeType: CanvasNodeType.Config, title: "生成配置", position: { x: Math.max(0, ...snapshot.nodes.map((node) => node.position.x + node.width)) + 96, y: 0 }, metadata }, ...sourceIds.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: id })), { type: "run_generation", nodeId: id, mode, prompt: stringValue("prompt") }]);
            return { ok: true, nodeId: id, status: "submitted" };
        }
        return { ok: false, code: "unsupported_action", message: `暂不支持工具 ${action.name}` };
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ color: theme.node.text }}>
            <div className="flex h-12 shrink-0 items-center justify-between border-b px-3" style={{ borderColor: theme.node.stroke }}>
                <div className="flex items-center gap-2"><span className="grid size-8 place-items-center"><Bot className="size-4" /></span><span className="text-sm font-semibold">{t("agent.browser.title")}</span></div>
                <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" icon={<PanelRightClose className="size-4" />} aria-label={t("agent.panel.collapseLabel")} onClick={onClose} />
            </div>
            {!hasCanvas ? <div className="p-4"><Alert type="info" showIcon message={t("agent.browser.canvasRequired")} /></div> : !isConfigReady ? (
                <div className="space-y-3 p-4"><Alert type="warning" showIcon message={t("agent.browser.configRequired")} /><Button icon={<Sparkles className="size-4" />} onClick={() => useConfigStore.getState().openConfigDialog(false, "channels")}>{t("agent.browser.openConfig")}</Button></div>
            ) : null}
            <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {!messages.length && isConfigReady && hasCanvas ? <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm" style={{ color: theme.node.muted }}><Sparkles className="size-5" /><span>{t("agent.browser.empty")}</span></div> : messages.map((item) => <div key={item.id} className="mb-4"><AgentChatMessage item={item} theme={theme} /></div>)}
            </div>
            <div className="shrink-0 border-t" style={{ borderColor: theme.node.stroke }}>
                {sending ? <div className="flex items-center gap-2 px-4 pt-2 text-xs" style={{ color: theme.node.muted }}><LoaderCircle className="size-3.5 animate-spin" />{t("agent.browser.running")}</div> : null}
                <AgentChatPromptInput value={prompt} disabled={!hasCanvas || sending} placeholder={t("agent.browser.placeholder")} theme={theme} onChange={setPrompt} onSubmit={() => void send()} />
                {sending ? <div className="px-4 pb-2 text-right"><Button type="text" size="small" onClick={() => abortRef.current?.abort()}>{t("agent.browser.stop")}</Button></div> : null}
            </div>
        </div>
    );
}
