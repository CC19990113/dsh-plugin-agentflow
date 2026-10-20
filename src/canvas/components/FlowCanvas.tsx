// 画布层：把 Board 映射成 React Flow 的 nodes / edges，
// 拖动、连线、选中、派生都通过 App 传进来的回调落到服务端。
// 主题：监听 <html class="dark">，切换背景 / 连线 / MiniMap 的配色。

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge as FlowEdge,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type Position,
  type OnNodeDrag,
} from '@xyflow/react';
import { Workflow } from 'lucide-react';
import type { Board, NodeStatus } from '../types';
import CardNode, { type CardFlowNode } from './CardNode';

interface Props {
  board: Board;
  selectedId: string | null;
  running: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onDerive: (id: string, dir: 'prev' | 'next') => void;
  onConnect: (from: string, to: string) => void;
}

/** 卡片宽度，和 CardNode 里的 w-[340px] 保持一致，供初始尺寸使用 */
const CARD_WIDTH = 340;


/**
 * 连线中点标出「这条边上传了多少内容」。
 * 这是画布上唯一能看见数据流大小的地方 —— 节点上只有自己的产出，
 * 但一条边上流的到底是什么、有多重，只有在这里看得见。
 */
function DataEdge(props: {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  style?: CSSProperties;
  markerEnd?: string;
  /** flow = 这条边正在「有东西流过去」（下游正在跑）；flowColor 是流动层的颜色 */
  data?: { label?: string; flow?: boolean; flowColor?: string };
}) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data } = props;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const flowing = Boolean(data?.flow);
  const flowColor =
    data?.flowColor ||
    (typeof props.style?.stroke === 'string' ? props.style.stroke : '#3f7ae0');
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {/* 处理中的「水流」：短划虚线沿线滚动 + 一个光点循环移动。
          用 SVG SMIL 而不是 CSS keyframes，免得动全局样式表。 */}
      {flowing && (
        <>
          <path
            d={path}
            fill="none"
            stroke={flowColor}
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeDasharray="9 7"
            opacity={1}
            style={{ filter: `drop-shadow(0 0 3px ${flowColor})` }}
          >
            <animate
              attributeName="stroke-dashoffset"
              from="0"
              to="-32"
              dur="0.9s"
              repeatCount="indefinite"
            />
          </path>
          <circle r={4.6} fill={flowColor} stroke="#ffffff" strokeWidth={1.5} opacity={1}
            style={{ filter: `drop-shadow(0 0 4px ${flowColor})` }}>
            <animateMotion dur="3.2s" repeatCount="indefinite" path={path} />
          </circle>
        </>
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
            }}
            className="rounded bg-[#FCFCFA]/90 px-1.5 py-0.5 text-[10px] leading-none text-[#8b8b85] dark:bg-[#121312]/90 dark:text-[#8b8b85]"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { data: DataEdge };

const nodeTypes = { card: CardNode } as NodeTypes;

/** 浅色主题的最小地图配色 */
const MINIMAP_COLOR: Record<NodeStatus, string> = {
  idle: '#d4dae4',
  running: '#9dbcf4',
  done: '#a9d5b8',
  failed: '#efb4b4',
  blocked: '#d4d9e1',
  review: '#f2d29b',
};

/** 暗色主题的最小地图配色：状态色的暗版 */
const MINIMAP_COLOR_DARK: Record<NodeStatus, string> = {
  idle: '#3a4150',
  running: '#4d7bd0',
  done: '#3f8f63',
  failed: '#9c4f4f',
  blocked: '#3a4150',
  review: '#9a6f2c',
};

/**
 * 主题判断（内联模式适配）：
 *   - 内联进 DSH 后 .dark 挂在画布根容器（.af-canvas）上，不再改 documentElement；
 *   - 独立浏览器打开时仍看 html.dark。
 * 两处都读，切换时 App 还会派发 themechange，双保险。
 */
function readDark(): boolean {
  try {
    if (document.documentElement.classList.contains('dark')) return true;
    const canvasRoot = document.querySelector('.af-canvas');
    return Boolean(canvasRoot && canvasRoot.classList.contains('dark'));
  } catch {
    return false;
  }
}

/** 监听 html 与画布根容器上的 .dark 类；Lead 切换主题时会派发 themechange，双保险 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() => (typeof document === 'undefined' ? false : readDark()));

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const sync = () => setDark(readDark());

    sync();
    const observers: MutationObserver[] = [];
    const observe = (target: Element | null) => {
      if (!target) return;
      const observer = new MutationObserver(sync);
      observer.observe(target, { attributes: true, attributeFilter: ['class'] });
      observers.push(observer);
    };
    observe(document.documentElement);
    observe(document.querySelector('.af-canvas'));
    window.addEventListener('themechange', sync);

    return () => {
      for (const observer of observers) observer.disconnect();
      window.removeEventListener('themechange', sync);
    };
  }, []);

  return dark;
}

export default function FlowCanvas({
  board,
  selectedId,
  running,
  onSelect,
  onMove,
  onDerive,
  onConnect,
}: Props) {
  const dark = useIsDark();

  const buildNodes = useCallback(
    (): CardFlowNode[] =>
      board.nodes.map((node) => ({
        id: node.id,
        type: 'card',
        position: { x: node.x, y: node.y },
        data: {
          node,
          selected: node.id === selectedId,
          running,
          onDerive,
        },
        selectable: false,
        deletable: false,
        focusable: false,
        initialWidth: CARD_WIDTH,
      })),
    [board.nodes, selectedId, running, onDerive]
  );

  // 本地 nodes 让拖拽过程即时跟手；拖完再通过 onMove 持久化。
  const [nodes, setNodes] = useState<CardFlowNode[]>(buildNodes);

  useEffect(() => {
    setNodes(buildNodes());
  }, [buildNodes]);

  const handleNodesChange = useCallback((changes: NodeChange<CardFlowNode>[]) => {
    // 只接受位置 / 尺寸类变更；选中交给 selectedId 控制，避免两套状态打架。
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleNodeClick = useCallback<NodeMouseHandler<CardFlowNode>>(
    (_event, node) => {
      onSelect(node.id);
    },
    [onSelect]
  );

  const handleNodeDragStop = useCallback<OnNodeDrag<CardFlowNode>>(
    (_event, node) => {
      onMove(node.id, Math.round(node.position.x), Math.round(node.position.y));
    },
    [onMove]
  );

  const handlePaneClick = useCallback(() => {
    onSelect(null);
  }, [onSelect]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        onConnect(connection.source, connection.target);
      }
    },
    [onConnect]
  );

  const edges = useMemo<FlowEdge[]>(() => {
    const runningTargets = new Set(
      board.nodes.filter((n) => n.status === 'running').map((n) => n.id)
    );
    const idleStroke = dark ? '#3a4150' : '#ccd4e0';
    const hotStroke = dark ? '#6f9cf2' : '#93b6f3';
    const idleMarker = dark ? '#3f4757' : '#c6cfdc';
    // 选中卡片时把与它相连的线点亮，其余压暗，一眼看出这张卡的上下游
    const focusStroke = dark ? '#6aa583' : '#24543F';
    const focusMarker = dark ? '#6aa583' : '#24543F';

    const nodeById = new Map(board.nodes.map((n) => [n.id, n]));
    return board.edges.map((edge) => {
      const focused = Boolean(selectedId) && (edge.from === selectedId || edge.to === selectedId);
      const dimmed = Boolean(selectedId) && !focused;
      const hot = runningTargets.has(edge.to);
      const color = focused ? focusStroke : hot ? hotStroke : idleStroke;
      // 上游跑出内容后把体量标在线上；没内容就不标 —— 空标签没有信息量
      const up = nodeById.get(edge.from);
      const len = up?.content ? up.content.length : 0;
      const label = len > 0
        ? (len >= 1000 ? `${(len / 1000).toFixed(1)}k 字` : `${len} 字`)
        : undefined;
      return {
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: 'data',
        data: {
          label,
          // 运行中的入边、以及选中节点的相关边都流光：点卡片立刻能看到「在动」
          flow: hot || focused,
          flowColor: focused ? focusStroke : hotStroke,
        },
        animated: false,
        style: {
          stroke: color,
          strokeWidth: focused ? 3 : hot ? 2 : 1.5,
          opacity: dimmed ? 0.12 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 15,
          height: 15,
          color: focused ? focusMarker : hot ? hotStroke : idleMarker,
          ...(dimmed ? { opacity: 0.12 } : {}),
        },
      } satisfies FlowEdge;
    });
  }, [board.edges, board.nodes, dark, selectedId]);

  const minimapColors = dark ? MINIMAP_COLOR_DARK : MINIMAP_COLOR;

  return (
    <div className="relative h-full w-full bg-[#F4F5F2] dark:bg-[#0f1116]">
      <ReactFlow<CardFlowNode, FlowEdge>
        nodes={nodes}
        edges={edges}
        edgeTypes={edgeTypes}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.8}
        deleteKeyCode={null}
        connectionRadius={28}
        connectionLineStyle={{ stroke: '#24543F', strokeWidth: 1.8 }}
        proOptions={{ hideAttribution: true }}
        className="h-full w-full"
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={20}
          size={1}
          color={dark ? '#1e1f1c' : '#e8eae4'}
          bgColor={dark ? '#0f1116' : '#F4F5F2'}
        />

        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!m-4 overflow-hidden rounded-xl border border-[#E2E4E0] bg-white shadow-[0_6px_20px_rgba(16,24,40,0.07)] dark:border-[#262b36] dark:bg-[#1a1d25] dark:shadow-[0_6px_20px_rgba(0,0,0,0.5)] [&_button]:h-7 [&_button]:w-7 [&_button]:border-b [&_button]:border-[#eef1f5] [&_button]:bg-white [&_button]:text-[#5b6472] [&_button:hover]:bg-[#f5f7fa]"
        />

        <MiniMap<CardFlowNode>
          position="bottom-right"
          pannable
          zoomable
          style={{ width: 168, height: 108 }}
          bgColor={dark ? '#151821' : '#ffffff'}
          maskColor={dark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(247, 248, 250, 0.74)'}
          nodeBorderRadius={4}
          nodeStrokeWidth={0}
          nodeColor={(node) =>
            minimapColors[node.data.node.status] ?? minimapColors.idle
          }
          className="!m-4 overflow-hidden rounded-xl border border-[#E2E4E0] shadow-[0_6px_20px_rgba(16,24,40,0.08)] dark:border-[#262b36] dark:shadow-[0_6px_20px_rgba(0,0,0,0.5)]"
        />
      </ReactFlow>

      {board.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <div className="flex -translate-y-6 flex-col items-center text-center">
            <span className="mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-[#E2E4E0] bg-white text-[#24543F] shadow-[0_4px_16px_rgba(16,24,40,0.06)] dark:border-[#262b36] dark:bg-[#1a1d25] dark:text-[#8fb3f2] dark:shadow-[0_4px_16px_rgba(0,0,0,0.4)]">
              <Workflow size={22} strokeWidth={1.8} />
            </span>
            <p className="text-[15px] font-medium text-[#1C1C1A] dark:text-[#e7e9ee]">
              画布还是空的
            </p>
            <p className="mt-1 max-w-[340px] text-[13px] leading-relaxed text-[#8a93a3] dark:text-[#8b93a5]">
              派生第一张卡片，就能在这里拖拽、连线、跑图了。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
