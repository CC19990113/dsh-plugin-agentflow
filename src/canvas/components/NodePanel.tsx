import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Checkbox, Input, Select, Tree, TreeSelect } from 'antd';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  LoaderCircle,
  RotateCcw,
  Search,
  Trash,
  X,
} from 'lucide-react';
import { NODE_TYPE_OPTIONS } from './CardNode';
import type {
  BridgeStatus,
  Edge,
  FlowNode,
  McpServer,
  ModelCatalog,
  NodeStatus,
  Skill,
  VerifyMode,
} from '../types';

interface Props {
  node: FlowNode;
  nodes: FlowNode[];
  edges: Edge[];
  /** 当前画布 id：上游连线的读写都落在这张画布上 */
  boardId: string;
  skills: Skill[];
  servers: McpServer[];
  /** DSH 的模型目录：provider 分组 + 每组的模型与推理档位 */
  catalog: ModelCatalog | null;
  /** bridge 连接状态：模型通道只有 DSH 内核这一条 */
  bridge: BridgeStatus | null;
  running: boolean;
  onPatch: (patch: Partial<FlowNode>) => void;
  onDerive: (dir: 'prev' | 'next') => void;
  onVerify: (pass: boolean) => void;
  onRerun: () => void;
  /** 重新拉 DSH 的模型目录（刚在 DSH 里加了供应商时用） */
  onRefreshModels: () => void;
  /** 边上改了要同步给画布：面板自己更新 localEdges 不够，画布用的是 App 的 board */
  onEdgesChange: (edges: Edge[]) => void;
  onDelete: () => void;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/* 视觉常量：纸面 / 墨 / 线 / 墨绿 / 朱橙                                */
/* ------------------------------------------------------------------ */

const INK = 'text-[#1B1B18] dark:text-[#EDEDE8]';
const MUTED = 'text-[#5F5F59] dark:text-[#A8A8A0]';
const FAINT = 'text-[#7C7C75] dark:text-[#8E8E86]';
const LINE = 'border-[#E3E4DF] dark:border-[#2E3037]';
/** 区块卡片：浅色白卡压在纸面上，深色抬高一档，才有分块感 */
const CARD = 'border-[#E6E7E2] bg-white dark:border-[#2E3037] dark:bg-[#1E1F24]';

/** 老画布里存的值不在当前 DSH 目录时，用这个占位值显示，不污染真实字段 */
const LEGACY_MODEL = '__legacy__';

/** 分组父节点的 value：与 provider 分组一样用 p: 前缀，但不会和 provider id 撞上 */
const RECENT_GROUP_VALUE = 'p:__recent__';
const LEGACY_GROUP_VALUE = 'p:__legacy__';

/**
 * 最近使用里模型节点的 value 前缀：存储里仍是 `provider/model`，
 * 但树里要和 provider 分组下的同值节点错开，否则 rc-tree-select 会报重复 value。
 */
const RECENT_PREFIX = 'r:';

const RECENT_MODELS_KEY = 'agentflow.recentModels';
const RECENT_MODELS_MAX = 5;

/** 最近使用的一条：value = `<provider>/<modelId>`，label = 模型名，provider = 路由 id */
interface RecentModel {
  value: string;
  label: string;
  provider: string;
}

/** 读最近使用；localStorage 被禁用或内容损坏都当空处理，绝不拖垮面板 */
function readRecentModels(): RecentModel[] {
  try {
    const raw = window.localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list: RecentModel[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.value !== 'string' || !rec.value) continue;
      if (typeof rec.provider !== 'string' || !rec.provider) continue;
      if (typeof rec.label !== 'string') continue;
      list.push({ value: rec.value, label: rec.label, provider: rec.provider });
      if (list.length >= RECENT_MODELS_MAX) break;
    }
    return list;
  } catch {
    return [];
  }
}

/** 写最近使用；配额满 / 隐私模式 / 序列化失败都静默忽略 */
function writeRecentModels(list: RecentModel[]): void {
  try {
    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(list));
  } catch {
    /* 忽略 */
  }
}

/** `provider/modelId` → 两半；没有斜杠时 provider 为空 */
function splitModelValue(value: string): { provider: string; model: string } {
  const slash = value.indexOf('/');
  if (slash <= 0) return { provider: '', model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** legacy 值（不在目录里）的显示：有 provider 时带上，老画布只有 model 时原样 */
function legacyModelLabel(provider: string | undefined, model: string): string {
  return `${provider ? `${provider} · ${model}` : model}（不在 DSH 目录里）`;
}

/** TreeSelect 里的一个节点：label 是选中后显示的文字，带 provider 防同名混淆 */
type ModelTreeNode = {
  title: string;
  label: string;
  value: string;
  selectable?: boolean;
  disabled?: boolean;
  children?: ModelTreeNode[];
};

/**
 * 兜底模型的推理强度：key = `provider/model`，value = 档位（'' = 模型默认）。
 * types.ts 的 FlowNode 还没跟进这个字段（本次只改本文件），先用局部扩展顶上。
 */


const STATUS_META: Record<NodeStatus, { label: string; dot: string }> = {
  idle: { label: '待运行', dot: 'bg-[#a8a8a0] dark:bg-[#6f6f68]' },
  running: { label: '运行中', dot: 'bg-[#B4451F] dark:bg-[#e08a6a] animate-pulse' },
  done: { label: '完成', dot: 'bg-[#24543F] dark:bg-[#6aa583]' },
  failed: { label: '失败', dot: 'bg-[#B4451F] dark:bg-[#e08a6a]' },
  blocked: { label: '阻塞', dot: 'bg-[#8b8b85] dark:bg-[#8b8b85]' },
  review: { label: '待确认', dot: 'bg-[#B4451F] dark:bg-[#e08a6a]' },
};

interface VerifyOption {
  value: VerifyMode;
  label: string;
  desc: string;
}

const VERIFY_OPTIONS: VerifyOption[] = [
  { value: '', label: '不校验', desc: '跑完就结束，不判断结果' },
  { value: 'human', label: '人工', desc: '跑完停住，等你点通过' },
  { value: 'jev', label: 'jev', desc: '调 TypeSafe 判定工具打分' },
  { value: 'self', label: '模型自行判断', desc: '同一个模型自评是否达标' },
];

/* 方形复选框：覆盖 antd 默认的圆润外观，只用它提供的结构与键盘交互 */
const PANEL_CSS = `
.af-panel .ant-checkbox {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid #C9CBC4;
  background: transparent;
}
.af-panel .ant-checkbox:not(.ant-checkbox-disabled):hover {
  border-color: #24543F;
}
.af-panel .ant-checkbox-input {
  width: 14px;
  height: 14px;
}
.af-panel .ant-checkbox-checked {
  border-color: #24543F;
  background: #24543F;
}
.af-panel .ant-checkbox-checked:hover {
  border-color: #1D4634;
  background: #1D4634;
}
.af-panel .ant-checkbox-checked::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 4px;
  width: 3px;
  height: 6px;
  border: solid #FFFFFF;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
  background: transparent;
}
.af-panel .ant-checkbox-disabled {
  border-color: #E3E4DF;
  background: #F4F5F2;
}
.dark .af-panel .ant-checkbox {
  border-color: #4A4D46;
  background: transparent;
}
.dark .af-panel .ant-checkbox:not(.ant-checkbox-disabled):hover {
  border-color: #6AA583;
}
.dark .af-panel .ant-checkbox-checked {
  border-color: #6AA583;
  background: #6AA583;
}
.dark .af-panel .ant-checkbox-checked:hover {
  border-color: #7FB59B;
  background: #7FB59B;
}
.dark .af-panel .ant-checkbox-checked::after {
  border-color: #17201B;
}
.dark .af-panel .ant-checkbox-disabled {
  border-color: #33342F;
  background: #232421;
}

.af-panel .af-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  margin: 0;
  padding: 0 2px;
  border-bottom: 1px solid #F0F1EC;
  transition: background-color 0.12s;
}
.af-panel .af-row:last-child {
  border-bottom: 0;
}
.af-panel .af-row:hover {
  background: #F7F7F3;
}
.af-panel .af-row > span:last-child {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding-inline-start: 0;
  padding-inline-end: 0;
}
.af-panel .af-row.af-row-disabled {
  opacity: 0.5;
}
.dark .af-panel .af-row {
  border-bottom-color: #232421;
}
.dark .af-panel .af-row:hover {
  background: #1d1e1b;
}
`;

const FIELD =
  'w-full rounded-lg border border-[#E1E2DD] bg-[#FCFCFA] px-2.5 py-2 text-[13px] leading-[1.65] text-[#1B1B18] outline-none transition-colors placeholder:text-[#9a9a92] focus:border-[#24543F] focus:bg-white dark:border-[#33353B] dark:bg-[#17181B] dark:text-[#EDEDE8] dark:focus:border-[#6aa583] dark:focus:bg-[#1B1C20]';

const TEXT_BUTTON =
  'rounded-[4px] px-2.5 py-1.5 text-[12px] text-[#5b6472] transition-colors hover:bg-[#EFEFEA] dark:text-[#a3a39b] dark:hover:bg-[#232421]';

export default function NodePanel(props: Props) {
  return (
    <aside
      className="af-panel absolute bottom-0 right-0 top-14 z-30 flex w-[420px] flex-col border-l border-[#E3E4DF] bg-[#FCFCFA] dark:border-[#262724] dark:bg-[#17181B]"
      role="complementary"
      aria-label="节点详情"
    >
      <style>{PANEL_CSS}</style>
      <NodePanelBody key={props.node.id} {...props} />
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 主体                                                                */
/* ------------------------------------------------------------------ */

/** 列表搜索：名称与描述都参与，大小写不敏感 */
function matchesQuery(query: string, ...fields: (string | undefined | null)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => String(f ?? '').toLowerCase().includes(q));
}

function NodePanelBody(props: Props) {
  const {
    node,
    nodes,
    edges,
    boardId,
    skills,
    servers,
    catalog,
    bridge,
    running,
    onPatch,
    onDerive,
    onVerify,
    onRerun,
    onRefreshModels,
    onEdgesChange,
    onDelete,
    onClose,
  } = props;

  const [label, setLabel] = useState(node.label);
  const [task, setTask] = useState(node.task);
  const [criteria, setCriteria] = useState(node.criteria);
  // 最近换过的模型：跨节点、跨会话复用，只存在浏览器里
  const [recentModels, setRecentModels] = useState<RecentModel[]>(readRecentModels);
  // 「添加兜底」下拉的选择重置用：加完 remount，清掉上次选中项
  const [addNonce, setAddNonce] = useState(0);
  // 技能 / MCP 工具列表的搜索词；MCP 的展开状态受控，搜索时全部展开
  const [skillQuery, setSkillQuery] = useState('');
  const [mcpQuery, setMcpQuery] = useState('');
  const [mcpExpanded, setMcpExpanded] = useState<string[] | null>(null);

  const taskRef = useRef<HTMLTextAreaElement | null>(null);
  const criteriaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    autoGrow(taskRef.current);
  }, [task]);

  useEffect(() => {
    autoGrow(criteriaRef.current);
  }, [criteria]);

  // 文本字段防抖落盘：停手 400ms / 失焦时统一 onPatch
  const onPatchRef = useRef(onPatch);
  useEffect(() => {
    onPatchRef.current = onPatch;
  }, [onPatch]);

  const pendingRef = useRef<Partial<FlowNode>>({});
  const patchTimerRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (patchTimerRef.current !== null) {
      window.clearTimeout(patchTimerRef.current);
      patchTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (Object.keys(pending).length) {
      pendingRef.current = {};
      onPatchRef.current(pending);
    }
  }, []);

  const queuePatch = useCallback(
    (patch: Partial<FlowNode>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (patchTimerRef.current !== null) window.clearTimeout(patchTimerRef.current);
      patchTimerRef.current = window.setTimeout(flush, 400);
    },
    [flush]
  );

  useEffect(() => {
    return () => {
      if (patchTimerRef.current !== null) {
        window.clearTimeout(patchTimerRef.current);
        patchTimerRef.current = null;
        const pending = pendingRef.current;
        if (Object.keys(pending).length) onPatchRef.current(pending);
      }
    };
  }, []);

  // ⌘S 由 App 统一保存：先把防抖中的文字改动立刻 flush，否则会漏掉最后 400ms 的输入
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') flush();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [flush]);

  // 上游连线：只改本地（画布统一走手动保存）；App 的 board.edges 由 onEdgesChange 同步
  const [localEdges, setLocalEdges] = useState<Edge[]>(edges);

  useEffect(() => {
    setLocalEdges(edges);
  }, [edges]);

  const upstreamIds = new Set(
    localEdges.filter((e) => e.to === node.id).map((e) => e.from)
  );
  const others = nodes.filter((n) => n.id !== node.id);

  function setUpstreams(nextIds: string[]) {
    const merged = [
      ...localEdges.filter((e) => e.to !== node.id),
      ...nextIds.map((from) => ({ from, to: node.id })),
    ];
    setLocalEdges(merged);
    // 画布渲染的是 App 里的 board.edges，不同步过去会「勾了却没线」
    onEdgesChange(merged);
  }

  function toggleSkill(name: string, checked: boolean) {
    const set = new Set(node.skills);
    if (checked) set.add(name);
    else set.delete(name);
    onPatch({ skills: [...set] });
  }

  function toggleTool(key: string, checked: boolean) {
    const set = new Set(node.tools);
    if (checked) set.add(key);
    else set.delete(key);
    onPatch({ tools: [...set] });
  }

  // 模型选项来自 DSH 目录（provider 分组）。老画布的 model 存的是 provider 名，
  // 目录里找不到就把旧值单独列一条，避免静默改掉别人的配置。
  const catalogProviders = catalog?.providers ?? [];
  const currentValue =
    node.provider && node.model ? `${node.provider}/${node.model}` : '';
  const selectionInCatalog = catalogProviders.some(
    (p) => p.id === node.provider && p.models.some((m) => m.id === node.model)
  );
  const legacyValue = node.model && !selectionInCatalog ? node.model : '';
  const currentModel = selectionInCatalog
    ? catalogProviders
        .find((p) => p.id === node.provider)
        ?.models.find((m) => m.id === node.model) ?? null
    : null;
  const effortLevels = currentModel?.levels ?? [];
  const effortDefault = currentModel?.defaultLevel ?? '';
  const modelDirectoryEmpty = catalogProviders.every((p) => !p.models.length);

  // 最近使用：存储里可能还留着目录中已删掉的模型，这里只保留目录里还有的 + 去重
  const recentSeen = new Set<string>();
  const recentTreeNodes: ModelTreeNode[] = [];
  for (const rec of recentModels) {
    const { provider: pid, model: mid } = splitModelValue(rec.value);
    const provider = catalogProviders.find((p) => p.id === pid);
    const model = provider?.models.find((m) => m.id === mid);
    if (!provider || !model || recentSeen.has(rec.value)) continue;
    recentSeen.add(rec.value);
    recentTreeNodes.push({
      title: model.name,
      label: `${provider.label} · ${model.name}`,
      // 加前缀只为避开重复 value，换模型时会去掉
      value: `${RECENT_PREFIX}${rec.value}`,
    });
  }

  const modelTreeData: ModelTreeNode[] = [];
  if (recentTreeNodes.length) {
    modelTreeData.push({
      title: '最近使用',
      label: '最近使用',
      value: RECENT_GROUP_VALUE,
      selectable: false,
      children: recentTreeNodes,
    });
  }
  if (legacyValue) {
    modelTreeData.push({
      title: '当前值',
      label: '当前值',
      value: LEGACY_GROUP_VALUE,
      selectable: false,
      children: [
        {
          title: legacyValue,
          label: legacyModelLabel(node.provider, legacyValue),
          value: LEGACY_MODEL,
        },
      ],
    });
  }
  for (const p of catalogProviders) {
    const count = p.models.length;
    modelTreeData.push({
      // 分组标题带上数量；搜索按 title 过滤时也能命中 provider 名
      title: count ? `${p.label}（${count}）` : p.label,
      label: p.label,
      value: `p:${p.id}`,
      selectable: false,
      children: p.error
        ? [{ title: p.error, label: p.error, value: `e:${p.id}`, disabled: true }]
        : p.models.map((m) => ({
            title: m.name,
            label: `${p.label} · ${m.name}`,
            value: `${p.id}/${m.id}`,
          })),
    });
  }

  // 默认只展开当前 provider（没有当前值就用最近用过的 provider），全展开会淹掉面板
  const currentProviderInCatalog = catalogProviders.find((p) => p.id === node.provider);
  const lastUsedProvider = recentModels
    .map((r) => r.provider)
    .find((pid) => catalogProviders.some((p) => p.id === pid));
  const expandedProvider = currentProviderInCatalog?.id ?? lastUsedProvider ?? '';
  const defaultExpandedKeys = [
    ...(recentTreeNodes.length ? [RECENT_GROUP_VALUE] : []),
    ...(legacyValue ? [LEGACY_GROUP_VALUE] : []),
    ...(expandedProvider ? [`p:${expandedProvider}`] : []),
  ];

  // 选中的显示值：目录里的用 `provider/model`，不在目录里的老值单独承载
  const selectedModelValue = selectionInCatalog
    ? currentValue
    : legacyValue
      ? LEGACY_MODEL
      : undefined;

  // 兜底：fallback 是模型 key 列表（顺序即重试顺序），fallbackEfforts 存每条自己的强度
  const fallback = node.fallback ?? [];
  const fallbackEfforts: Record<string, string> = node.fallbackEfforts ?? {};
  const fallbackSet = new Set(fallback);

  // 「添加兜底」的下拉：同目录树，排除主模型和已经加过的
  const fallbackTreeData: ModelTreeNode[] = catalogProviders
    .map((p) => {
      const count = p.models.length;
      const children: ModelTreeNode[] = p.error
        ? [{ title: p.error, label: p.error, value: `e:${p.id}`, disabled: true }]
        : p.models
            .filter((m) => {
              const key = `${p.id}/${m.id}`;
              return key !== currentValue && !fallbackSet.has(key);
            })
            .map((m) => ({
              title: m.name,
              label: `${p.label} · ${m.name}`,
              value: `${p.id}/${m.id}`,
            }));
      return {
        title: count ? `${p.label}（${count}）` : p.label,
        label: p.label,
        value: `p:${p.id}`,
        selectable: false,
        children,
      };
    })
    .filter((group) => group.children.length > 0);
  const fallbackExpandedKeys = expandedProvider ? [`p:${expandedProvider}`] : [];

  function applyModel(raw: string) {
    // 「当前值」占位节点：只看不改，老画布的配置不能因为点一下就被抹掉
    if (!raw || raw === LEGACY_MODEL) return;
    const value = raw.startsWith(RECENT_PREFIX)
      ? raw.slice(RECENT_PREFIX.length)
      : raw;
    const { provider: pid, model: mid } = splitModelValue(value);
    const provider = catalogProviders.find((p) => p.id === pid);
    const picked = provider?.models.find((m) => m.id === mid);
    if (!provider || !picked) return;
    // 换模型后旧档位可能不被支持，这时退回「模型默认」
    const kept = picked.levels.includes(node.reasoningEffort ?? '')
      ? node.reasoningEffort ?? ''
      : '';
    const entry: RecentModel = { value, label: picked.name, provider: pid };
    const nextRecent = [
      entry,
      ...recentModels.filter((r) => r.value !== entry.value),
    ].slice(0, RECENT_MODELS_MAX);
    setRecentModels(nextRecent);
    writeRecentModels(nextRecent);
    onPatch({ provider: pid, model: mid, reasoningEffort: kept });
  }

  /** 兜底 key 的显示名与可选档位（目录里找不到时按 legacy 处理，强度禁用） */
  function fallbackModelInfo(key: string): { label: string; levels: string[] } {
    const { provider: pid, model: mid } = splitModelValue(key);
    const provider = catalogProviders.find((p) => p.id === pid);
    const model = provider?.models.find((m) => m.id === mid);
    if (!provider || !model) return { label: `${key}（不在 DSH 目录里）`, levels: [] };
    return { label: `${provider.label} · ${model.name}`, levels: model.levels };
  }

  /**
   * 兜底和强度是一对，永远一起落库；
   * 删除某条时同步删掉 fallbackEfforts 的键，避免脏数据。
   */
  function patchFallback(nextFallback: string[], nextEfforts: Record<string, string>) {
    const patch: Partial<FlowNode> = {
      fallback: nextFallback,
      fallbackEfforts: nextEfforts,
    };
    onPatch(patch);
  }

  /** 添加：先按「模型默认」强度加入，强度在行内改；成功后重置下拉 */
  function addFallback(raw: string | undefined) {
    if (!raw || !raw.includes('/') || fallbackSet.has(raw)) return;
    patchFallback([...fallback, raw], { ...fallbackEfforts, [raw]: '' });
    setAddNonce((n) => n + 1);
  }

  function removeFallback(key: string) {
    const nextEfforts = { ...fallbackEfforts };
    delete nextEfforts[key];
    patchFallback(
      fallback.filter((k) => k !== key),
      nextEfforts
    );
  }

  function changeFallbackEffort(key: string, effort: string) {
    patchFallback(fallback, { ...fallbackEfforts, [key]: effort });
  }

  const status = STATUS_META[node.status] ?? STATUS_META.idle;
  // 调度（根）节点：人格就是任务字段，导出预设时 persona 取它
  const isOrchestrator = node.type === 'orchestrator';
  // 是否已经有别的根节点（用于限制「调度（根）」只能有一张）
  const otherRootExists = nodes.some((n) => n.id !== node.id && n.type === 'orchestrator');
  const nodeTypeOptions = NODE_TYPE_OPTIONS.map((opt) => ({
    ...opt,
    disabled: opt.value === 'orchestrator' && otherRootExists,
  }));
  const selectedVerify =
    VERIFY_OPTIONS.find((o) => o.value === (node.verify ?? '')) ?? VERIFY_OPTIONS[0];
  const isReview = node.status === 'review';

  // 技能 / MCP 搜索：名称与描述都匹配；空搜索时保持原顺序
  const filteredSkills = skills.filter((skill) =>
    matchesQuery(skillQuery, skill.name, skill.description),
  );
  const filteredServers = servers
    .map((server) => ({
      ...server,
      tools: server.tools.filter((tool) => matchesQuery(mcpQuery, tool.name, tool.description)),
    }))
    .filter((server) => matchesQuery(mcpQuery, server.name) || server.tools.length > 0);
  // 搜索时把命中的 server 全展开；平时记住用户手动展开的，首次用「第一个连上的」
  const mcpExpandedKeys = mcpQuery.trim()
    ? filteredServers.map((server) => server.name)
    : (mcpExpanded ?? servers.filter((sv) => sv.ok && sv.tools.length).slice(0, 1).map((sv) => sv.name));

  return (
    <>
      {/* 标题行 */}
      <header
        className={`flex shrink-0 items-center gap-2 border-b ${LINE} bg-[#FAFAF7] px-5 py-3.5 dark:bg-[#1B1C20]`}
      >
        <input
          value={label}
          onChange={(e) => {
            const value = e.target.value;
            setLabel(value);
            queuePatch({ label: value });
          }}
          onBlur={flush}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          placeholder="节点名称"
          aria-label="节点名称"
          className={`min-w-0 flex-1 rounded-[3px] border-0 bg-transparent p-0 text-[17px] font-semibold tracking-tight outline-none placeholder:text-[#a8a8a0] focus-visible:ring-2 focus-visible:ring-[#24543F]/30 dark:placeholder:text-[#6f6f68] dark:focus-visible:ring-[#6aa583]/40 ${INK}`}
        />

        <span className={`flex shrink-0 items-center gap-1.5 text-[12px] ${MUTED}`}>
          <span className={`h-[6px] w-[6px] rounded-full ${status.dot}`} />
          {status.label}
        </span>

        <button
          type="button"
          onClick={onClose}
          aria-label="关闭详情"
          title="关闭"
          className={`-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-[4px] text-[#6b6b66] transition-colors hover:bg-[#EFEFEA] dark:text-[#8b8b85] dark:hover:bg-[#232421]`}
        >
          <X size={16} />
        </button>
      </header>

      {/* 判定结果 */}
      {node.verdict && (
        <div
          className={`shrink-0 border-b px-5 py-2 text-[12px] leading-[1.5] ${LINE} ${
            node.verdict.pass
              ? 'bg-[#EEF3EF] text-[#24543F] dark:bg-[#1B2A22] dark:text-[#8FC3A7]'
              : 'bg-[#FBEFEA] text-[#B4451F] dark:bg-[#2A1C17] dark:text-[#E08A6A]'
          }`}
        >
          {verdictByLabel(node.verdict.by)} {node.verdict.pass ? '通过' : '未通过'}
          {node.verdict.reason ? `：${node.verdict.reason}` : ''}
        </div>
      )}

      {/* 错误 */}
      {node.error && (
        <div
          className={`shrink-0 border-b px-5 py-2 text-[12px] leading-[1.5] ${LINE} bg-[#FBEFEA] text-[#B4451F] dark:bg-[#2A1C17] dark:text-[#E08A6A]`}
        >
          {node.error}
        </div>
      )}

      {/* 可滚动内容 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
        {/* 根节点的类型是固定的（对话入口），不给改也不显示 */}
        {isOrchestrator ? null : (
          <Section title="节点类型">
            <Select
              value={node.type || 'llm'}
              onChange={(v: string) => onPatch({ type: v })}
              // 一张画布只能有一个调度根节点：已经有时其它卡片不能再选
              options={nodeTypeOptions}
              aria-label="节点类型"
              className="w-full"
              size="middle"
            />
            {otherRootExists ? (
              <p className={`mt-1.5 text-[11px] leading-[1.5] ${FAINT}`}>
                画布已有根节点，这张卡不能再设为调度卡。
              </p>
            ) : null}
          </Section>
        )}

        <Section
          title="模型"
          extra={
            <button
              type="button"
              onClick={onRefreshModels}
              title="重新读取 DSH 的模型目录"
              className={`flex items-center gap-1 text-[11px] transition-opacity hover:opacity-70 ${FAINT}`}
            >
              <RotateCcw size={11} />
              刷新
            </button>
          }
        >
          <div className="space-y-1.5">
            <TreeSelect
              value={selectedModelValue}
              placeholder="选择模型"
              showSearch
              treeNodeFilterProp="title"
              treeDefaultExpandAll={false}
              treeDefaultExpandedKeys={defaultExpandedKeys}
              // 选中后显示「provider · 模型名」：同名的模型分属两个 provider 时才分得清
              treeNodeLabelProp="label"
              treeData={modelTreeData}
              onChange={applyModel}
              aria-label="模型"
              className="w-full"
              size="middle"
            />

            {/* 推理强度：档位来自 DSH 的模型元数据 */}
            <Select
              value={node.reasoningEffort ?? ''}
              onChange={(v: string) => onPatch({ reasoningEffort: v })}
              disabled={!effortLevels.length}
              aria-label="推理强度"
              title={effortLevels.length ? '推理强度' : '当前模型没有可选推理档位'}
              options={[
                {
                  value: '',
                  label: `推理强度：模型默认${effortDefault ? `（${effortDefault}）` : ''}`,
                },
                ...effortLevels.map((lv) => ({ value: lv, label: lv })),
              ]}
              className="w-full"
              size="middle"
            />

            {modelDirectoryEmpty && (
              <div className={`flex items-start gap-1.5 text-[11px] leading-[1.6] ${MUTED}`}>
                <span className="mt-[5px] h-[3px] w-[3px] shrink-0 rounded-full bg-current opacity-50" />
                <span>没读到 DSH 的模型目录，检查 DSH 凭据或网络。</span>
              </div>
            )}

            {/* 模型通道只有 DSH 内核一条：bridge 没连上就跑不了图 */}
            <div
              className={`flex items-start gap-1.5 border-t border-[#EDEEE9] pt-2 text-[11px] leading-[1.6] dark:border-[#2A2C31] ${
                bridge && !bridge.healthy ? 'text-[#B4451F] dark:text-[#e08a6a]' : MUTED
              }`}
            >
              <span className="mt-[5px] h-[3px] w-[3px] shrink-0 rounded-full bg-current opacity-60" />
              <span>
                模型通道：DSH 内核（未连接时不可跑图）
                {bridge && !bridge.healthy ? ` · ${bridge.reason || '原因未知'}` : ''}
              </span>
            </div>
          </div>
        </Section>

        <Section
          title="兜底模型"
          extra={
            fallback.length ? (
              <span className={`text-[11px] ${MUTED}`}>{fallback.length} 个 · 按顺序重试</span>
            ) : undefined
          }
        >
          <div className="space-y-1.5">
            {/* 兜底模型：主模型失败后按顺序尝试，每条可单独设推理强度 */}
            {fallback.map((key) => {
              const info = fallbackModelInfo(key);
              return (
                <div
                  key={key}
                  className={`flex min-h-[32px] items-center gap-2 border-b py-1 last:border-b-0 ${LINE}`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-[12px] ${INK}`}
                    title={info.label}
                  >
                    {info.label}
                  </span>
                  <Select
                    size="small"
                    value={fallbackEfforts[key] ?? ''}
                    disabled={!info.levels.length}
                    title={info.levels.length ? '这条兜底的推理强度' : '该模型没有可选推理档位'}
                    options={[
                      { value: '', label: '模型默认' },
                      ...info.levels.map((lv) => ({ value: lv, label: lv })),
                    ]}
                    onChange={(v: string) => changeFallbackEffort(key, v)}
                    aria-label={`${info.label} 的推理强度`}
                    style={{ width: 104 }}
                  />
                  <button
                    type="button"
                    onClick={() => removeFallback(key)}
                    aria-label={`移除兜底模型 ${info.label}`}
                    title="移除"
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-[4px] transition-colors hover:bg-[#FBEFEA] hover:text-[#B4451F] dark:hover:bg-[#2A1C17] dark:hover:text-[#e08a6a] ${FAINT}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}

            {/* 选中即加入（模型默认强度），强度在上面行内改；key 用来加入后清空选择 */}
            <TreeSelect
              key={addNonce}
              onChange={addFallback}
              placeholder="添加兜底模型…"
              showSearch
              treeNodeFilterProp="title"
              treeDefaultExpandAll={false}
              treeDefaultExpandedKeys={fallbackExpandedKeys}
              treeNodeLabelProp="label"
              treeData={fallbackTreeData}
              aria-label="添加兜底模型"
              className="w-full"
              size="middle"
            />

            <div className={`flex items-start gap-1.5 pt-0.5 text-[11px] leading-[1.6] ${MUTED}`}>
              <span className="mt-[5px] h-[3px] w-[3px] shrink-0 rounded-full bg-current opacity-50" />
              <span>兜底模型：主模型失败后按顺序尝试，可单独设推理强度</span>
            </div>
          </div>
        </Section>

        <Section title={isOrchestrator ? '人格' : '任务'}>
          <textarea
            ref={taskRef}
            rows={3}
            value={task}
            onChange={(e) => {
              setTask(e.target.value);
              queuePatch({ task: e.target.value });
              autoGrow(e.currentTarget);
            }}
            onBlur={flush}
            placeholder={
              isOrchestrator
                ? '默认：只负责和用户对话，再严格按后续节点的 AgentFlow 流执行（可自己改）'
                : '写清楚这张卡要做什么…'
            }
            className={`${FIELD} max-h-[240px] resize-none overflow-y-auto`}
          />
          {isOrchestrator && (
            <p className={`mt-1.5 text-[11px] leading-[1.5] ${FAINT}`}>
              默认人格只是起点，可以自己改：它只负责和用户对话，确认需求后严格按后续节点的流程执行。
            </p>
          )}
        </Section>

        <Section title="完成标准">
          <textarea
            ref={criteriaRef}
            rows={2}
            value={criteria}
            onChange={(e) => {
              setCriteria(e.target.value);
              queuePatch({ criteria: e.target.value });
              autoGrow(e.currentTarget);
            }}
            onBlur={flush}
            placeholder="做到什么程度算完成…"
            className={`${FIELD} max-h-[200px] resize-none overflow-y-auto`}
          />
        </Section>

        <Section title="结果判断">
          <div
            role="radiogroup"
            aria-label="结果判断"
            className="flex gap-[2px] rounded-[6px] bg-[#EFEFEA] p-[3px] dark:bg-[#232421]"
          >
            {VERIFY_OPTIONS.map((opt) => {
              // 老节点的 verify 可能是 undefined（没写过这个字段），按「不校验」处理
              const active = (node.verify ?? '') === opt.value;
              return (
                <button
                  key={opt.value || 'none'}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  title={opt.desc}
                  onClick={() => onPatch({ verify: opt.value })}
                  className={`flex-1 rounded-[4px] px-1 py-[5px] text-[13px] leading-[1.3] transition-colors ${
                    active
                      ? 'bg-white text-[#1B1B18] shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-[#3A3B35] dark:text-[#e8e8e4]'
                      : `hover:text-[#1B1B18] dark:hover:text-[#e8e8e4] ${MUTED}`
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className={`mt-1.5 text-[11px] leading-[1.5] ${FAINT}`}>{selectedVerify.desc}</p>
          {(node.verify ?? '') === 'jev' && (
            <p className="mt-1.5 rounded-[4px] border border-[#E9D9B8] bg-[#FBF4E6] px-2 py-1.5 text-[11px] leading-[1.5] text-[#8a6220] dark:border-[#4a3a1c] dark:bg-[#2a2314] dark:text-[#e0b866]">
              需要本机安装 jev（TypeSafe）并配置 API key，否则这张卡跑到判定时会失败。
            </p>
          )}
        </Section>

        <Section
          title="技能"
          extra={<span className={`text-[11px] ${FAINT}`}>已选 {node.skills.length}</span>}
        >
          {skills.length === 0 ? (
            <EmptyHint>没有找到技能</EmptyHint>
          ) : (
            <>
              <Input
                value={skillQuery}
                onChange={(e) => setSkillQuery(e.target.value)}
                allowClear
                size="middle"
                placeholder="搜索技能名或描述…"
                aria-label="搜索技能"
                prefix={<Search size={12} className={FAINT} />}
                className="mb-2"
              />
              {filteredSkills.length === 0 ? (
                <EmptyHint>没有匹配「{skillQuery.trim()}」的技能</EmptyHint>
              ) : null}
              <div className="max-h-[180px] overflow-y-auto">
              {filteredSkills.map((skill) => {
                const checked = node.skills.includes(skill.name);
                return (
                  <Checkbox
                    key={skill.name}
                    className="af-row"
                    checked={checked}
                    onChange={(e) => toggleSkill(skill.name, e.target.checked)}
                    title={skill.description}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className={`shrink-0 text-[13px] ${INK}`}>{skill.name}</span>
                      <span className={`min-w-0 flex-1 truncate text-right text-[11px] ${FAINT}`}>
                        {skill.description || '无描述'}
                      </span>
                    </span>
                  </Checkbox>
                );
              })}
              </div>
            </>
          )}
        </Section>

        <Section
          title="MCP 工具"
          extra={<span className={`text-[11px] ${FAINT}`}>已选 {node.tools.length}</span>}
        >
          {servers.length === 0 ? (
            <EmptyHint>还没配置 MCP 服务器</EmptyHint>
          ) : (
            <>
              <Input
                value={mcpQuery}
                onChange={(e) => setMcpQuery(e.target.value)}
                allowClear
                size="middle"
                placeholder="搜索服务器或工具…"
                aria-label="搜索 MCP 工具"
                prefix={<Search size={12} className={FAINT} />}
                className="mb-2"
              />
              {filteredServers.length === 0 ? (
                <EmptyHint>没有匹配「{mcpQuery.trim()}」的工具</EmptyHint>
              ) : null}
            <div className="max-h-[180px] overflow-y-auto af-tree">
              <Tree
                checkable
                selectable={false}
                // 展开状态受控：搜索时全部展开，平时记住用户手动的展开
                expandedKeys={mcpExpandedKeys}
                onExpand={(keys) => setMcpExpanded(keys as string[])}
                treeData={filteredServers.map((server) => ({
                  key: server.name,
                  selectable: false,
                  title: (
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-[5px] w-[5px] shrink-0 rounded-full ${
                          server.ok
                            ? 'bg-[#24543F] dark:bg-[#6aa583]'
                            : 'bg-[#B4451F] dark:bg-[#e08a6a]'
                        }`}
                      />
                      <span className={`text-[12px] font-medium ${INK}`}>{server.name}</span>
                      <span className={`text-[11px] ${FAINT}`}>{server.tools.length} 个工具</span>
                      {!server.ok && (
                        <span className="text-[11px] text-[#B4451F] dark:text-[#e08a6a]">连接失败</span>
                      )}
                    </span>
                  ),
                  children: server.tools.map((tool) => ({
                    key: `${server.name}.${tool.name}`,
                    title: (
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className={`shrink-0 text-[13px] ${INK}`}>{tool.name}</span>
                        <span className={`min-w-0 flex-1 truncate text-right text-[11px] ${FAINT}`}>
                          {tool.description}
                        </span>
                      </span>
                    ),
                  })),
                }))}
                checkedKeys={node.tools}
                onCheck={(checked: React.Key[] | { checked: React.Key[]; halfChecked: React.Key[] }) => {
                  const keys = Array.isArray(checked) ? checked : checked.checked;
                  // 父节点（server 名）由 antd 自己算，只把叶子 server.tool 存进节点
                  onPatch({ tools: keys.filter((k: React.Key) => String(k).includes('.')) as string[] });
                }}
              />
            </div>
            </>
          )}
        </Section>

        {/* 根节点是流程起点，没有上游：整块不显示 */}
        {isOrchestrator ? null : (
        <Section title="上游">
          {others.length === 0 ? (
            <EmptyHint>还没有其它卡片</EmptyHint>
          ) : (
            <div className="max-h-[180px] overflow-y-auto">
              {others.map((other) => {
                const checked = upstreamIds.has(other.id);
                // 已有 本卡→该节点 的路径时，再加 该节点→本卡 会成环
                const wouldCycle =
                  !checked && hasPath(localEdges, node.id, other.id);
                const nextIds = checked
                  ? [...upstreamIds].filter((id) => id !== other.id)
                  : [...upstreamIds, other.id];
                return (
                  <Checkbox
                    key={other.id}
                    className={`af-row ${wouldCycle ? 'af-row-disabled' : ''}`}
                    checked={checked}
                    disabled={wouldCycle}
                    onChange={() => setUpstreams(nextIds)}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className={`min-w-0 flex-1 truncate text-[13px] ${INK}`}>
                        {other.label || other.id}
                      </span>
                      {wouldCycle && (
                        <span className={`shrink-0 text-[11px] ${FAINT}`}>会成环</span>
                      )}
                    </span>
                  </Checkbox>
                );
              })}
            </div>
          )}
        </Section>
        )}
      </div>

      {/* 待确认操作条 */}
      {isReview && (
        <div className={`shrink-0 border-t ${LINE} bg-[#FAEFE6] px-5 py-3 dark:bg-[#2A1C17]`}>
          <p className="text-[12px] text-[#B4451F] dark:text-[#e08a6a]">
            这张卡跑完了，等你判断结果
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onVerify(true)}
              className="h-8 flex-1 rounded-[4px] bg-[#24543F] text-[13px] font-medium text-white transition-colors hover:bg-[#1D4634] dark:bg-[#3F7A5F] dark:hover:bg-[#4B8B6D]"
            >
              通过
            </button>
            <button
              type="button"
              onClick={() => onVerify(false)}
              className="h-8 flex-1 rounded-[4px] text-[13px] text-[#6b6b66] transition-colors hover:bg-white/60 dark:text-[#a3a39b] dark:hover:bg-[#232421]"
            >
              打回重跑
            </button>
          </div>
        </div>
      )}

      {/* 底部操作 */}
      <footer className={`shrink-0 border-t ${LINE} bg-[#FAFAF7] px-5 py-3 dark:bg-[#1B1C20]`}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRerun}
            disabled={running}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[4px] bg-[#24543F] text-[13px] font-medium text-white transition-colors hover:bg-[#1D4634] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#3F7A5F] dark:hover:bg-[#4B8B6D]"
          >
            {running ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <RotateCcw size={13} />
            )}
            {running ? '运行中…' : '重跑此卡'}
          </button>
          {isOrchestrator ? null : (
            <button
              type="button"
              onClick={() => onDerive('prev')}
              className={`${TEXT_BUTTON} flex items-center gap-1`}
            >
              <ArrowUp size={13} />
              加上游
            </button>
          )}
          <button
            type="button"
            onClick={() => onDerive('next')}
            className={`${TEXT_BUTTON} flex items-center gap-1`}
          >
            <ArrowDown size={13} />
            加下游
          </button>
        </div>
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={onDelete}
            disabled={isOrchestrator}
            title={isOrchestrator ? '根节点是对话入口（人格来源），不能删除' : undefined}
            className="flex items-center gap-1.5 rounded-[4px] px-2.5 py-1.5 text-[12px] text-[#B4451F] transition-colors hover:bg-[#FBEFEA] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-[#e08a6a] dark:hover:bg-[#2A1C17]"
          >
            <Trash size={13} />
            删除此卡
          </button>
        </div>
      </footer>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 小部件 / 工具                                                       */
/* ------------------------------------------------------------------ */

function Section({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`mt-3 rounded-xl border p-3 first:mt-1 ${CARD}`}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className={`text-[12px] font-semibold tracking-[0.01em] ${INK}`}>{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p className={`py-1 text-[12px] leading-[1.6] ${FAINT}`}>{children}</p>;
}

/** 从 from 出发是否能走到 to */
function hasPath(edges: Edge[], from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const e of edges) {
      if (e.from !== cur) continue;
      if (e.to === to) return true;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return false;
}

function verdictByLabel(by: string): string {
  if (by === 'human') return '人工';
  if (by === 'jev') return 'jev';
  if (by === 'self') return '自评';
  return by || '系统';
}

function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}
