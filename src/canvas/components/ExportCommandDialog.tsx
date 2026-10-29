import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Alert, Button, Flex, Input, Modal, Typography, theme } from 'antd';
import { Download, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { CommandRecord, ExportCommandResult } from '../api';

const { Text } = Typography;

const MONO =
  "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', ui-monospace, monospace";

interface Props {
  open: boolean;
  /** 导出哪张画布；空时后端用索引里的第一张 */
  boardId?: string | null;
  /** 画布名：只用于展示（命令名默认按画布 id 生成） */
  boardName?: string;
  onClose: () => void;
}

interface ErrorState {
  title: string;
  detail?: string;
}

export default function ExportCommandDialog({ open, boardId, boardName, onClose }: Props) {
  const { token } = theme.useToken();

  const [result, setResult] = useState<ExportCommandResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [records, setRecords] = useState<CommandRecord[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadCommands = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await api.listCommands();
      setRecords(res.commands);
    } catch {
      // 列表只是辅助信息：读不到也不挡生成
      setRecords([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  // 每次打开重置，并拉一次已有命令
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    setLoading(false);
    setName('');
    void loadCommands();
  }, [open, loadCommands]);

  async function generate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const trimmed = name.trim();
      const res = await api.exportCommand(boardId, trimmed || undefined);
      setResult(res);
      await loadCommands();
    } catch (err) {
      const raw = (err as Error).message || '未知错误';
      setError({
        title: raw.includes('HTTP 400') ? '生成失败（检查命令名）' : '生成失败',
        detail: raw,
      });
    } finally {
      setLoading(false);
    }
  }

  async function remove(recordName: string) {
    if (deleting) return;
    const ok = window.confirm(`删除命令 /${recordName}？删掉后 DSH 里立刻就不能用了。`);
    if (!ok) return;
    setDeleting(recordName);
    setError(null);
    try {
      await api.deleteCommand(recordName);
      if (result?.name === recordName) setResult(null);
      await loadCommands();
    } catch (err) {
      setError({ title: '删除失败', detail: (err as Error).message });
    } finally {
      setDeleting(null);
    }
  }

  const boardCommands = records.filter((r) => !boardId || r.board === boardId);

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
      title="生成斜杠命令"
      width={640}
      centered
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
        title="把这张画布挂成一条 DSH 斜杠命令：生成后在对话里输入 /命令名，就能进入这张画布的工作流（无参数先看画布，带文字直接进流程）。命令即时生效，不用重启 DSH。"
        style={{ marginBottom: 16 }}
      />

      <div style={{ marginBottom: 12 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          当前画布：
        </Text>
        <Text strong style={{ fontSize: 12 }}>
          {boardName || boardId || '索引里的第一张画布'}
        </Text>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Text style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>命令名（可选）</Text>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="留空＝按画布 id 自动生成（agentflow-…）"
          maxLength={48}
          disabled={loading}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          小写字母开头，只允许 a-z 0-9 _ -，不超过 48 个字符；同名会覆盖旧命令。
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
        <div style={{ marginBottom: 16 }}>
          <Alert
            type="success"
            showIcon
            title={result.replaced ? '命令已更新（覆盖了同名旧命令）' : '命令已生成'}
            description={
              <div>
                <div style={{ marginBottom: 4 }}>
                  命令名：
                  <Text code copyable style={{ fontSize: 12 }}>
                    /{result.name}
                  </Text>
                </div>
                <div style={{ marginBottom: 4 }}>
                  用法：在 DSH 对话里输入 <Text code style={{ fontSize: 12 }}>/{result.name}</Text>
                  ，回车即可。
                </div>
                <div style={{ marginBottom: 4 }}>
                  <b>已即时生效，无需重启。</b>
                </div>
                <div>
                  文件：
                  <Text code copyable style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {result.file}
                  </Text>
                </div>
              </div>
            }
          />
          <Flex justify="flex-end" style={{ marginTop: 8 }}>
            <Button
              size="small"
              danger
              icon={<Trash2 size={13} />}
              loading={deleting === result.name}
              onClick={() => void remove(result.name)}
            >
              删除命令
            </Button>
          </Flex>
        </div>
      )}

      <div>
        <Flex align="baseline" justify="space-between" style={{ marginBottom: 6 }}>
          <Text strong style={{ fontSize: 13 }}>
            这张画布已有的命令
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {listLoading ? '读取中…' : `${boardCommands.length} 条`}
          </Text>
        </Flex>
        {boardCommands.length === 0 ? (
          <div style={{ ...panelStyle, color: token.colorTextTertiary }}>
            {listLoading ? '正在读取…' : '还没有命令，点右下角「生成」创建一条。'}
          </div>
        ) : (
          <div style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8 }}>
            {boardCommands.map((row, index) => (
              <Flex
                key={row.name}
                align="center"
                gap={8}
                style={{
                  padding: '8px 12px',
                  borderTop: index === 0 ? undefined : `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Text code style={{ fontSize: 12 }}>
                  /{row.name}
                </Text>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {formatWhen(row.createdAt)}
                </Text>
                <div style={{ marginLeft: 'auto' }}>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<Trash2 size={13} />}
                    loading={deleting === row.name}
                    onClick={() => void remove(row.name)}
                  >
                    删除
                  </Button>
                </div>
              </Flex>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 创建时间：YYYY-MM-DD HH:mm（和画布列表同一口径） */
function formatWhen(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}
