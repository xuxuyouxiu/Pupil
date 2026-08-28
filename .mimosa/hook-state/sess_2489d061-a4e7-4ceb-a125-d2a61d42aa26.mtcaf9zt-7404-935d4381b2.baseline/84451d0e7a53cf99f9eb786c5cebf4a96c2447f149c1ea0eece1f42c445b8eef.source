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

/** v0.5.0 完成保持窗口：turn_completed 后视图保持 done 态的时长（星星眼/弹跳可见期） */
export const DONE_HOLD_MS_DEFAULT = 4000

/** 悬浮球窗口尺寸 */
export const BALL_SIZE = 56
export const BALL_HOVER_SCALE = 1.1

/** v0.5.0 状态播报气泡带：球窗向上扩出的高度（球体 SVG 定位在该带之下） */
export const BUBBLE_BAND = 20
/** v0.5.0 球体左右留白（窗口宽 = BALL_SIZE + 2×此值；拖动命中区随之加宽 4px） */
export const BALL_WINDOW_INSET_X = 4

/** 面板窗口尺寸 */
export const PANEL_WIDTH = 360
export const PANEL_MAX_HEIGHT = 480

/** 独立设置窗口尺寸（P1-2：面板内设置视图升级） */
export const SETTINGS_WIDTH = 380
export const SETTINGS_HEIGHT = 520

/** 环形内存缓冲上限（每会话保留的事件数） */
export const EVENT_RING_BUFFER_SIZE = 1000

/**
 * 会话清理：session_ended 后展示宽限期（契约见 session-registry 注释），到期由推断 tick 清除
 */
export const SESSION_ENDED_RETENTION_MS = 30 * 1000

/** 历史恢复条目（restoredOnly）的最大保留时长：过期整条清除，防止长期驻留内存单调膨胀 */
export const RESTORED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 数据目录名（%APPDATA%/pupil） */
export const DATA_DIR_NAME = 'pupil'
