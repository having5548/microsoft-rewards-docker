/**
 * 演示模式只允许通过本地显式开关启用。
 * 生产镜像会设置 NODE_ENV=production，因此旧容器残留的 MSR_ENABLE_DEMO
 * 不会再把正式实例切到演示数据。
 */
export function isDemoMode() {
  return process.env.NODE_ENV !== 'production' && process.env.MSR_ENABLE_DEMO === '1';
}
