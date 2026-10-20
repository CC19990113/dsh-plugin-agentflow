import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Alert,
  Button,
  Flex,
  Input,
  Modal,
  Tag,
  Typography,
  theme,
} from 'antd';
import { Download } from 'lucide-react';
import { api } from '../api';
import type { ExportPresetResult } from '../api';

const { Text } = Typography;

const MONO =
  "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', ui-monospace, monospace";

interface Props {
  open: boolean;
  /** 导出哪张画布；空时后端用索引里的第一张 */
  boardId?: string | null;
  /** 画布名：预设名默认用它，用户可以改 */
  boardName?: string;
  onClose: () => void;
}

interface ErrorState {
  title: string;
  detail?: string;
}

export default function ExportPresetDialog({ open, boardId, boardName, onClose }: Props) {
  const { token } = theme.useToken();

  const [result, setResult] = useState<ExportPresetResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [presetName, setPresetName] = useState('');

  // 每次打开重置；预设名默认取画布名（导出对象由 App 传进来）
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    setLoading(false);
    setPresetName(boardName || '');
  }, [open, boardName]);

  async function generate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.exportPreset(boardId, presetName.trim());
      setResult(res);

    } catch (err) {
      const raw = (err as Error).message || '未知错误';
      if (raw.includes('HTTP 404')) {
        setError({
          title: '暂不可用',
          detail: '后端还没有这个接口（POST /api/export/preset），等后端上线后再试。',
        });
      } else if (raw.includes('HTTP 409')) {
        setError({
          title: '自定义目录已存在，换个目录',
          detail: raw,
        });
      } else {
        setError({ title: '生成失败', detail: raw });
      }
    } finally {
      setLoading(false);
    }
  }

  const panelStyle: CSSProperties = {
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: 8,
    background: token.colorFillTertiary,
    padding: '10px 12px',
    fontFamily: MONO,
    fontSize: 12,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: token.colorText,
  };

  return (
    <Modal
      open={open}
      title="导出为 DSH 预设"
      width={720}
      centered
      // 内联模式：弹层挂在画布根容器里，才能继承 .dark 与画布 CSS 变量
      getContainer={() => document.querySelector<HTMLElement>('.af-canvas') ?? document.body}
      onCancel={onClose}
      styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
      footer={
        <Flex justify="flex-end" gap={8}>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            icon={<Download size={14} />}
            loading={loading}
            onClick={() => void generate()}
          >
            生成
          </Button>
        </Flex>
      }
    >
      <Alert
        type="info"
        showIcon
        title="把这张画布编译成 DSH 预设，直接写进 dsh-plugin-agentflow 插件包。重启 DSH 后，新会话的预设列表里就能选到它：主 agent 会先和你对齐需求，再按画布结构分层下发子 agent（提示词驱动，不保证严格按 DAG 执行）。"
        style={{ marginBottom: 16 }}
      />

      <div style={{ marginBottom: 16 }}>
        <Text style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>预设名称</Text>
        <Input
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          placeholder="在 DSH 预设列表里显示的名字"
          maxLength={40}
          disabled={Boolean(result)}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          只改显示名，预设 id 不变（重复导出还是覆盖同一个预设）。
        </Text>
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          title={error.title}
          description={
            error.detail ? (
              <Text style={{ fontSize: 12, fontFamily: MONO, wordBreak: 'break-all' }}>
                {error.detail}
              </Text>
            ) : undefined
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {result && (
        <>
          <Alert
            type="success"
            showIcon
            title={result.replaced ? '预设已更新' : '预设已写入插件'}
            description={
              <div>
                <div style={{ marginBottom: 6 }}>
                  已写进 profile 的 <b>cordis.patch.yml</b>（用标记段包裹，重新导出整段替换）。
                  <b>重启 DSH 后</b>，新会话的预设列表里就能选到它。
                </div>
                <div style={{ marginBottom: 4 }}>
                  预设 id：<Text code style={{ fontSize: 12 }}>{result.presetId}</Text>
                </div>
                <div>
                  文件：
                  <Text code copyable style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {result.file}
                  </Text>
                </div>
              </div>
            }
            style={{ marginBottom: 12 }}
          />

          {(result.addedOrchestrator || result.personaSource) && (
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
                调度与人设
              </Text>
              <Flex vertical gap={4}>
                {result.addedOrchestrator && (
                  <Text style={{ fontSize: 13 }}>
                    已自动补充调度卡：
                    <Text strong>{result.addedOrchestrator.label}</Text>
                  </Text>
                )}
                {result.personaSource && (
                  <Text style={{ fontSize: 13 }} type="secondary">
                    人格来源：{personaSourceText(result.personaSource)}
                  </Text>
                )}
              </Flex>
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
              写入文件
            </Text>
            <Tag style={{ marginInlineEnd: 0, fontFamily: MONO }}>{result.file}</Tag>
          </div>

        </>
      )}

      <div>
        <Flex align="baseline" justify="space-between" style={{ marginBottom: 6 }}>
          <Text strong style={{ fontSize: 13 }}>
            预览人格
          </Text>
          {result?.personaPreview && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {result.personaPreview.length} 字符
            </Text>
          )}
        </Flex>
        <pre style={{ ...panelStyle, margin: 0, maxHeight: 320, overflowY: 'auto' }}>
          {result?.personaPreview || '生成后会在这里显示完整的人格文本。'}
        </pre>
      </div>
    </Modal>
  );
}

/** personaSource → 中文说明；后端以后加新枚举也不至于显示空白 */
const PERSONA_SOURCE_TEXT: Record<string, string> = {
  orchestrator: '调度（根）节点的人格',
  'single-card': '单卡片画布（唯一那张卡）',
  'auto-orchestrator': '自动补充的调度卡',
};

function personaSourceText(source: string): string {
  return PERSONA_SOURCE_TEXT[source] ?? source;
}
