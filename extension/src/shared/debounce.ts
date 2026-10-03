/**
 * 防抖：高频触发只保留最后一次，延迟 wait 毫秒后执行。
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return (...args: A): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, wait);
  };
}

/**
 * 节流：在 interval 内最多执行一次（首次立即执行）。
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, interval: number): (...args: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return (...args: A): void => {
    const now = Date.now();
    const remaining = interval - (now - last);

    if (remaining <= 0) {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      last = now;
      fn(...args);
      return;
    }

    if (timer === undefined) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = undefined;
        fn(...args);
      }, remaining);
    }
  };
}