/**
 * 宿主（DSH Web）主题读取与订阅。
 *
 * DSH 的深色标记有两个来源，按优先级读：
 *   1. body[data-ds-dark-theme]  —— 官方主题开关当前用的属性
 *   2. html.dark                 —— 部分构建/插件会挂这个类
 * 都读不到时退回系统偏好（matchMedia），避免内联画布在深色 DSH 里闪白。
 */

export type HostTheme = 'light' | 'dark';

/** 读一次当前宿主主题（同步，不抛错） */
export function readHostTheme(): HostTheme {
  try {
    if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark';
  } catch {
    /* 读不到就继续兜底 */
  }
  try {
    if (document.documentElement.classList.contains('dark')) return 'dark';
  } catch {
    /* 忽略 */
  }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    /* 忽略 */
  }
  return 'light';
}

/**
 * 订阅宿主主题变化。变化时回调最新主题，返回取消订阅函数。
 * 只观察 light/dark 标记本身：MutationObserver + 系统配色兜底。
 */
export function subscribeHostTheme(onChange: (theme: HostTheme) => void): () => void {
  let last = readHostTheme();
  const emitter = () => {
    const next = readHostTheme();
    if (next === last) return;
    last = next;
    onChange(next);
  };

  const observers: MutationObserver[] = [];
  try {
    if (typeof MutationObserver !== 'undefined') {
      const bodyObserver = new MutationObserver(emitter);
      if (document.body) {
        bodyObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme', 'class'],
        });
        observers.push(bodyObserver);
      }
      const htmlObserver = new MutationObserver(emitter);
      htmlObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
      });
      observers.push(htmlObserver);
    }
  } catch {
    /* 观察失败不影响初始主题 */
  }

  let media: MediaQueryList | null = null;
  const onMedia = () => emitter();
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', onMedia);
  } catch {
    media = null;
  }

  // 窗口重新获得焦点时补一次：有些宿主主题切换不经过 DOM 属性
  window.addEventListener('focus', emitter);

  return () => {
    for (const observer of observers) observer.disconnect();
    if (media) {
      try {
        media.removeEventListener('change', onMedia);
      } catch {
        /* 忽略 */
      }
    }
    window.removeEventListener('focus', emitter);
  };
}
