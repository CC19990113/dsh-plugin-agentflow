// 预设工作流配置卡片：画布上的一张「配置」，不是运行产出。
// 只显示配置相关的信息（类型、模型/工具、技能与工具数量、任务首句）；
// 验证跑图时的状态用一个点表示，空闲时不显示。
// 暗色主题通过 .dark 类生效，所有颜色都成对给出，浅色值保持原样。

import type { MouseEvent as ReactMouseEvent } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Crown, Plug, Plus, Sparkles, type LucideIcon } from 'lucide-react';
import type { FlowNode, NodeStatus } from '../types';

export type CardNodeData = {
  node: FlowNode;
  selected: boolean;
  running: boolean;
  onDerive: (id: string, dir: 'prev' | 'next') => void;
};

export type CardFlowNode = Node<CardNodeData, 'card'>;

/* ------------------------------------------------------------------ */
/* 视觉常量                                                            */
/* ------------------------------------------------------------------ */

const STATUS: Record<NodeStatus, { label: string; dot: string; bar: string }> = {
  idle: {
    label: '空闲',
    dot: 'bg-[#b6becb] dark:bg-[#6b7385]',
    bar: '#c8cfda',
  },
  running: {
    label: '运行中',
    dot: 'bg-[#c2410c] dark:bg-[#fb923c]',
    bar: '#c2410c',
  },
  done: {
    label: '完成',
    dot: 'bg-[#3fa76b] dark:bg-[#6ee7a0]',
    bar: '#3fa76b',
  },
  failed: {
    label: '失败',
    dot: 'bg-[#e05252] dark:bg-[#f28b8b]',
    bar: '#e05252',
  },
  blocked: {
    label: '阻塞',
    dot: 'bg-[#b0b7c3] dark:bg-[#6b7385]',
    bar: '#b0b7c3',
  },
  review: {
    label: '待确认',
    dot: 'bg-[#f0a020] dark:bg-[#f4b95f]',
    bar: '#f0a020',
  },
};

type TypeMeta = { icon: LucideIcon; label: string; tone: string };

const TYPES: Record<string, TypeMeta> = {
  llm: {
    icon: Sparkles,
    label: 'LLM 节点',
    tone: 'bg-[#eef3fe] text-[#24543F] dark:bg-[#1b2a44] dark:text-[#8fb3f2]',
  },
  orchestrator: {
    icon: Crown,
    label: '调度（根）',
    // 赭红：和 judge 的琥珀、human 的墨绿都分得开；深色模式成对给
    tone: 'bg-[#fbeee8] text-[#a8542f] dark:bg-[#39231a] dark:text-[#e9a484]',
  },
  mcp: {
    icon: Plug,
    label: 'MCP 工具节点',
    tone: 'bg-[#f1eefe] text-[#7c6cf0] dark:bg-[#2a2440] dark:text-[#b3a6fa]',
  },
};

/** 节点类型下拉选项：和画布徽标共用 TYPES 的文案，避免两处漂移 */
export const NODE_TYPE_OPTIONS = Object.entries(TYPES).map(([value, meta]) => ({
  value,
  label: meta.label,
}));

const DEFAULT_TYPE: TypeMeta = {
  icon: Sparkles,
  label: '节点',
  tone: 'bg-[#f2f4f7] text-[#5b6472] dark:bg-[#232733] dark:text-[#a7aebb]',
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 任务首句：压平空白后截到第一个句末标点，卡片上再看两行 */
function firstSentence(text: string): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const match = flat.match(/^.*?[。！？!?；;]/);
  return (match ? match[0] : flat).trim();
}

/* ------------------------------------------------------------------ */
/* 组件                                                                */
/* ------------------------------------------------------------------ */

export default function CardNode({ data }: NodeProps<CardFlowNode>) {
  const { node, selected, running, onDerive } = data;

  const status = STATUS[node.status] ?? STATUS.idle;
  const meta = TYPES[node.type] ?? DEFAULT_TYPE;
  const TypeIcon = meta.icon;
  const isMcp = node.type === 'mcp';
  const modelText =
    (isMcp ? node.tool : node.model) || (isMcp ? '未设置工具' : '未设置模型');
  const skillCount = node.skills?.length ?? 0;
  const toolCount = node.tools?.length ?? 0;
  const taskText = firstSentence(node.task);

  const derive = (dir: 'prev' | 'next') => (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onDerive(node.id, dir);
  };

  const addBtn = (dir: 'prev' | 'next') => {
    const prev = dir === 'prev';
    const enabled = !running;
    return (
      <button
        type="button"
        title={
          !enabled
            ? '运行中暂不能派生卡片'
            : prev
              ? '在这张卡前面加一个上游（自动连线）'
              : '派生下一张卡（自动连线）'
        }
        aria-label={prev ? '添加上游卡片' : '派生下游卡片'}
        disabled={!enabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={derive(dir)}
        className={`nodrag nopan grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-[#98a1b0] transition-colors disabled:cursor-not-allowed disabled:opacity-35 dark:bg-[#232733] dark:text-[#8b8b85] ${
          prev
            ? 'hover:bg-[#eafaef] hover:text-[#2e7d32] dark:hover:bg-[#1b3327] dark:hover:text-[#6ee7a0]'
            : 'hover:bg-[#eef3fe] hover:text-[#24543F] dark:hover:bg-[#1b2a44] dark:hover:text-[#8fb3f2]'
        }`}
      >
        <Plus size={14} strokeWidth={2.2} />
      </button>
    );
  };

  const blocked = node.status === 'blocked';
  const surface = blocked ? 'bg-[#fcfcfd] dark:bg-[#181b23]' : 'bg-white dark:bg-[#1a1d25]';
  // 选中不再靠换边框颜色，改用外圈 ring —— 边框本身这次被整个去掉了
  const ring = selected
    ? 'ring-2 ring-[#24543F] ring-offset-2 ring-offset-[#F4F5F2] dark:ring-[#6aa583] dark:ring-offset-[#121312]'
    : '';
  const shadowTone = selected
    ? 'shadow-[0_10px_30px_-12px_rgba(36,84,63,0.35)] dark:shadow-[0_10px_30px_-12px_rgba(0,0,0,0.65)]'
    : 'shadow-[0_1px_3px_rgba(20,24,20,0.06),0_10px_28px_-18px_rgba(20,24,20,0.22)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.5),0_10px_28px_-18px_rgba(0,0,0,0.7)] hover:shadow-[0_2px_6px_rgba(20,24,20,0.08),0_16px_36px_-20px_rgba(20,24,20,0.3)] dark:hover:shadow-[0_2px_6px_rgba(0,0,0,0.55),0_16px_36px_-20px_rgba(0,0,0,0.8)]';

  return (
    <article
      aria-label={`${node.label || node.id}（${status.label}）`}
      className={`relative w-[340px] cursor-grab rounded-[4px] transition-shadow duration-150 active:cursor-grabbing ${surface} ${ring} ${shadowTone}`}
    >
      {/* 顶部状态色条：验证跑图时给个颜色提示，平时是一条很淡的线 */}
      <span
        aria-hidden
        className="absolute left-0 right-0 top-0 h-[2px] overflow-hidden rounded-t-[4px]"
        style={{ background: status.bar }}
      >
        {node.status === 'running' && (
          <span className="af-bar-scan absolute inset-y-0 w-1/2" />
        )}
      </span>

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {/* 标题行：派生按钮 + 类型徽标 + 名称 + 状态点 */}
      <div className="flex items-center gap-1.5 pb-2 pl-3 pr-3 pt-3">
        {addBtn('prev')}

        <span
          title={meta.label}
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-[7px] ${meta.tone}`}
        >
          <TypeIcon size={13.5} strokeWidth={2} />
        </span>

        <h3
          title={node.label || node.id}
          className="min-w-0 flex-1 truncate text-[15px] font-medium leading-6 text-[#1C1C1A] dark:text-[#e7e9ee]"
        >
          {node.label || node.id}
        </h3>

        {node.status !== 'idle' && (
          <span
            title={status.label}
            aria-label={status.label}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot} ${
              node.status === 'running' ? 'animate-pulse' : ''
            }`}
          />
        )}

        {addBtn('next')}
      </div>

      {/* 配置摘要：模型/工具、技能数与 MCP 数、任务首句 */}
      <div className="px-4 pb-3">
        <div className="flex items-center gap-2 border-t border-[#eef0ec] pt-2 text-[12px] leading-5 dark:border-[#232421]">
          <span className="shrink-0 text-[11px] text-[#98a1b0] dark:text-[#6d7586]">
            {isMcp ? '工具' : '模型'}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-[#333330] dark:text-[#c9cdc7]"
            title={modelText}
          >
            {modelText}
          </span>
        </div>

        <div className="mt-1 flex items-center gap-3 text-[11px] leading-5 text-[#6b6b66] dark:text-[#8b8b85]">
          <span>技能 {skillCount}</span>
          <span>MCP 工具 {toolCount}</span>
        </div>

        <p
          className={`mt-1.5 line-clamp-2 break-words text-[12.5px] leading-[1.6] ${
            taskText
              ? 'text-[#333330] dark:text-[#c9cdc7]'
              : 'italic text-[#aeb6c3] dark:text-[#6d7586]'
          }`}
          title={node.task || undefined}
        >
          {taskText || '未填写任务'}
        </p>
      </div>
    </article>
  );
}
