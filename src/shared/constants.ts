/** 全局默认常量（可被用户配置覆盖的部分存于 %APPDATA%/pupil/config.json） */

export const APP_NAME = 'Pupil'
export const APP_VERSION = '0.1.0'

/** HTTP 接收端点（通道 C）默认端口，占用则向上探测 */
export const HTTP_PORT_DEFAULT = 17734
export const HTTP_HOST = '127.0.0.1'

/** 事件速率限制：默认 100 事件/秒/会话 */
export const EVENT_RATE_LIMIT_PER_SEC = 100

/** 推断参数默认值 */
export const TIMEOUT_THRESHOLD_MS_DEFAULT = 10 * 60 * 1000 // 10 分钟
export const DISCONNECT_HEARTBEAT_MS_DEFAULT = 30 * 1000 // 30 秒无心跳判定断连

/** 悬浮球窗口尺寸 */
export const BALL_SIZE = 56
export const BALL_HOVER_SCALE = 1.1

/** 面板窗口尺寸 */
export const PANEL_WIDTH = 360
export const PANEL_MAX_HEIGHT = 480

/** 环形内存缓冲上限（每会话保留的事件数） */
export const EVENT_RING_BUFFER_SIZE = 1000

/** 数据目录名（%APPDATA%/pupil） */
export const DATA_DIR_NAME = 'pupil'
