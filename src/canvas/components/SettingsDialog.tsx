import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Modal,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { api } from '../api';
import type { BridgeStatus, ConfigInfo, McpServer } from '../types';

const { Text } = Typography;

interface Props {
  open: boolean;
  config: ConfigInfo | null;
  servers: McpServer[];
  onClose: () => void;
  onSaved: (cfg: { mock: boolean }) => void;
  onError: (msg: string) => void;
}

/** DSH 版 /api/config 的新增字段（types.ts 暂未跟进，这里局部声明） */
interface DshMcpServer {
  name: string;
  kind?: string;
}

interface DshPaths {
  patch?: string;
  credentials?: string;
  skills?: string;
}

interface DshConfigExtras {
  source?: string;
  readOnly?: boolean;
  mcpServers?: DshMcpServer[];
  skillDirs?: string[];
  dshPaths?: DshPaths;
}

type DshConfig = ConfigInfo & DshConfigExtras;

export default function SettingsDialog({
  open,
  config,
  servers,
  onClose,
  onSaved,
  onError,
}: Props) {
  const cfg = config as DshConfig | null;

  const [mock, setMock] = useState(cfg?.mock ?? false);
  const [switching, setSwitching] = useState(false);

  // 模型通道状态：设置页自己取一份，避免依赖画布那边的轮询
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // 每次打开时对齐 DSH 当前配置
  useEffect(() => {
    if (open) setMock(cfg?.mock ?? false);
  }, [open, cfg?.mock]);

  // 打开时拉一次模型通道状态；重新打开会重新读，DSH 重启后能立刻看到
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBridgeBusy(true);
    void api
      .getBridge()
      .then((next) => {
        if (!cancelled) setBridge(next);
      })
      .catch((err) => {
        if (!cancelled) onErrorRef.current(`读取模型通道状态失败：${(err as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setBridgeBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 刷新：重置服务端 10s 目录缓存 + 重新健康检查
  async function refreshChannel() {
    if (bridgeBusy) return;
    setBridgeBusy(true);
    const [status, models] = await Promise.allSettled([
      api.getBridge(),
      api.getModels(true),
    ]);
    if (status.status === 'fulfilled') setBridge(status.value);
    else onErrorRef.current(`读取模型通道状态失败：${(status.reason as Error).message}`);
    if (models.status === 'rejected') {
      onErrorRef.current(`重新读取模型目录失败：${(models.reason as Error).message}`);
    }
    setBridgeBusy(false);
  }

  async function toggleMock(next: boolean) {
    if (switching || !config) return;
    const prev = mock;
    setMock(next);
    setSwitching(true);
    try {
      const res = await api.putConfig({ mock: next });
      const saved = typeof res?.mock === 'boolean' ? res.mock : next;
      setMock(saved);
      onSaved({ mock: saved });
    } catch (err) {
      setMock(prev);
      onError(`切换 mock 失败：${(err as Error).message}`);
    } finally {
      setSwitching(false);
    }
  }

  const providers = Object.entries(cfg?.providers ?? {});
  const mcpServers: DshMcpServer[] = cfg?.mcpServers ?? servers.map((s) => ({ name: s.name }));
  const skillDirs = cfg?.skillDirs?.length
    ? cfg.skillDirs
    : cfg?.dshPaths?.skills
      ? [cfg.dshPaths.skills]
      : [];

  // 通道状态 Tag：healthy 但目录读失败时仍算「已连接」，目录错误走「最后错误」那行
  const channelTag = !bridge ? (
    <Text type="secondary" style={{ fontSize: 12 }}>
      读取中…
    </Text>
  ) : bridge.healthy ? (
    <Tag color="success" style={{ marginInlineEnd: 0 }}>
      已连接
    </Tag>
  ) : (
    <Tag color="warning" style={{ marginInlineEnd: 0 }}>
      未连接
    </Tag>
  );
  // lastError 优先：healthy=true 但 catalog 拉取失败时 reason 为空、lastError 有值
  const channelError = bridge ? bridge.lastError || bridge.reason || '' : '';

  return (
    <Modal
      open={open}
      title="设置"
      width={640}
      centered
      // 内联模式：弹层挂在画布根容器里，才能继承 .dark 与画布 CSS 变量
      getContainer={() => document.querySelector<HTMLElement>('.af-canvas') ?? document.body}
      onCancel={onClose}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto', paddingTop: 12 } }}
      footer={
        <Flex justify="flex-end">
          <Button onClick={onClose}>关闭</Button>
        </Flex>
      }
    >
      <Alert
        type="info"
        showIcon
        title="模型、MCP 服务器、技能都来自 DSH 的配置。要增删改请到 DSH 的 cordis.patch.yml，AgentFlow 这边只读。"
        description={
          cfg?.dshPaths?.patch ? (
            <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              patch：<Text code style={{ fontSize: 12 }}>{cfg.dshPaths.patch}</Text>
            </Text>
          ) : undefined
        }
      />

      {/* 模型 */}
      <Section title="模型" extra={<Text type="secondary" style={{ fontSize: 11 }}>{providers.length} 个</Text>}>
        {providers.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="DSH 没有配置模型提供商" />
        ) : (
          providers.map(([name, provider]) => (
            <Card
              key={name}
              size="small"
              style={{ marginBottom: 12 }}
              title={
                <Text strong style={{ fontSize: 14 }}>
                  {provider.label || name}
                </Text>
              }
              extra={
                provider.hasKey ? (
                  <Tag color="green" style={{ marginInlineEnd: 0 }}>
                    已配置 key
                  </Tag>
                ) : (
                  <Tag color="red" style={{ marginInlineEnd: 0 }}>
                    缺 key
                  </Tag>
                )
              }
            >
              <Descriptions
                size="small"
                column={1}
                colon={false}
                items={[
                  {
                    key: 'provider',
                    label: 'provider',
                    children: <Text code>{name}</Text>,
                  },
                  {
                    key: 'baseURL',
                    label: 'baseURL',
                    children: <Text code>{provider.baseURL || '—'}</Text>,
                  },
                  {
                    key: 'model',
                    label: 'model',
                    children: <Text code>{provider.model || '—'}</Text>,
                  },
                ]}
              />
            </Card>
          ))
        )}
      </Section>

      {/* 模型通道：DSH 内核 bridge 的发现文件 / 目录 / 健康状态 */}
      <Section
        title="模型通道"
        extra={
          <Button size="small" loading={bridgeBusy} onClick={() => void refreshChannel()}>
            刷新
          </Button>
        }
      >
        {bridge && !bridge.healthy && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            title="DSH 未运行或插件未加载，画布不能调模型"
          />
        )}
        <Descriptions
          size="small"
          bordered
          column={1}
          colon={false}
          items={[
            { key: 'status', label: '状态', children: channelTag },
            {
              key: 'infoPath',
              label: '发现文件',
              children: (
                <Text
                  code
                  style={{ fontSize: 12, wordBreak: 'break-all', userSelect: 'text' }}
                  title={bridge?.dir}
                >
                  {bridge?.infoPath || '—'}
                </Text>
              ),
            },
            {
              key: 'version',
              label: '版本',
              children: bridge?.version == null ? '—' : <Text code>{bridge.version}</Text>,
            },
            {
              key: 'startedAt',
              label: '启动时间',
              children: formatStartedAt(bridge?.startedAt ?? null),
            },
            {
              key: 'providers',
              label: 'provider 数',
              children: bridge ? String(bridge.providers) : '—',
            },
            {
              key: 'modelCount',
              label: '模型数',
              children: bridge ? String(bridge.modelCount) : '—',
            },
            {
              key: 'lastError',
              label: '最后错误',
              children: channelError ? (
                <Text type="danger" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {channelError}
                </Text>
              ) : (
                <Text type="secondary">—</Text>
              ),
            },
          ]}
        />
      </Section>

      {/* MCP 服务器 */}
      <Section
        title="MCP 服务器"
        extra={<Text type="secondary" style={{ fontSize: 11 }}>{mcpServers.length} 个</Text>}
      >
        {mcpServers.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="DSH 没有配置 MCP 服务器" />
        ) : (
          <Descriptions
            size="small"
            bordered
            column={1}
            colon={false}
            items={mcpServers.map((server) => ({
              key: server.name,
              label: (
                <Text strong style={{ fontSize: 13 }}>
                  {server.name}
                </Text>
              ),
              children: server.kind ? (
                <Tag style={{ marginInlineEnd: 0 }}>{server.kind}</Tag>
              ) : (
                <Text type="secondary">—</Text>
              ),
            }))}
          />
        )}
      </Section>

      {/* 技能目录 */}
      <Section
        title="技能目录"
        extra={<Text type="secondary" style={{ fontSize: 11 }}>{skillDirs.length} 个</Text>}
      >
        {skillDirs.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="DSH 没有配置技能目录" />
        ) : (
          <Flex vertical gap={6}>
            {skillDirs.map((dir) => (
              <Text
                key={dir}
                code
                style={{ fontSize: 12, wordBreak: 'break-all' }}
              >
                {dir}
              </Text>
            ))}
          </Flex>
        )}
      </Section>

      {/* mock：AgentFlow 自己的开关 */}
      <Section title="运行模式">
        <Card size="small">
          <Flex align="center" justify="space-between" gap={16}>
            <div style={{ minWidth: 0 }}>
              <Text strong style={{ display: 'block', fontSize: 15 }}>
                mock 模式
              </Text>
              <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                AgentFlow 自己的开关，不属于 DSH 配置。打开后不真正调用模型。
              </Text>
            </div>
            <Switch
              checked={mock}
              loading={switching}
              disabled={!config}
              onChange={(next) => void toggleMock(next)}
            />
          </Flex>
        </Card>
      </Section>
    </Modal>
  );
}

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
    <section style={{ marginTop: 20 }}>
      <Flex align="center" justify="space-between" gap={8} style={{ marginBottom: 8 }}>
        <Text strong style={{ fontSize: 13 }}>
          {title}
        </Text>
        {extra}
      </Flex>
      {children}
    </section>
  );
}

/** startedAt（epoch ms）→ YYYY-MM-DD HH:mm:ss；空值 / 非法值显示「—」 */
function formatStartedAt(ms: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
