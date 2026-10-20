/**
 * AgentFlow 后端 API 基地址。
 *
 * 内联进 DSH 后画布不再是同源页面（DSH Web 的 origin 是 127.0.0.1:端口，
 * 画布 API 在 8791），所以所有请求都必须显式带基地址。默认本机 8791，
 * 插件配置可在挂载画布前用 setApiBase() 覆盖。
 */

/** 默认地址：本机 AgentFlow 服务（与 runtime/server.mjs 的默认端口一致） */
export const DEFAULT_API_BASE = 'http://127.0.0.1:8791';

let apiBase = DEFAULT_API_BASE;

/** 归一化：去空白、去末尾斜杠；返回空串表示入参无效 */
export function normalizeApiBase(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * 设置 API 基地址。传空值保持默认，避免插件配置缺省时把画布打成相对路径。
 * 返回最终生效的地址，便于调用方日志/断言。
 */
export function setApiBase(value: string | null | undefined): string {
  const next = normalizeApiBase(value);
  if (next) apiBase = next;
  return apiBase;
}

/** 当前生效的 API 基地址 */
export function getApiBase(): string {
  return apiBase;
}

/** 拼一个后端 URL：path 以 / 开头 */
export function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${apiBase}${suffix}`;
}
