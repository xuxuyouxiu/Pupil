/**
 * 任务 DNA 徽章（v1.2.0）—— 纯函数：TaskCard -> 确定性 SVG 参数
 * 规格见 docs/ROADMAP-v2.md A.5：同输入必同图；视觉要素与任务数据一一映射
 */
import { TaskCard } from '../core/recap'

export interface GlyphParams {
  /** 外环分段数（工具调用总数，3..12） */
  segments: number
  /** 主色相（agentType 固定映射） */
  hue: number
  /** 内芯多边形边数（agentType） */
  sides: number
  /** 内芯散点数（错误数，0..8） */
  dots: number
  /** 整体旋转角（id hash） */
  rotation: number
  /** 环描边宽（tokens 对数三档：1.5/2.2/3） */
  ringWidth: number
  /** 辉光半径（同三档：0/1.5/2.5） */
  glow: number
}

const AGENT_HUE: Record<string, number> = {
  'claude-code': 24, // 橙
  codex: 190, // 青
  hermes: 270, // 紫
  zcode: 210, // 蓝
  dsh: 140, // 绿
  gemini: 48, // 亮金（Google 系）
  opencode: 320, // 品红
  workbuddy: 96, // 黄绿（豆包系）
  custom: 0 // 灰（饱和度另置）
}

const AGENT_SIDES: Record<string, number> = {
  'claude-code': 5,
  codex: 6,
  hermes: 7,
  zcode: 4,
  dsh: 8,
  gemini: 6,
  opencode: 9,
  workbuddy: 7,
  custom: 3
}

/** 简单字符串 hash（确定性旋转角） */
function hashId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}

export function buildGlyphParams(card: TaskCard): GlyphParams {
  const toolCalls = Object.values(card.tools).reduce((a, b) => a + b, 0)
  const totalTokens = card.tokensIn + card.tokensOut
  const hue = AGENT_HUE[card.agentType] ?? 0
  return {
    segments: Math.min(12, Math.max(3, toolCalls || 3)),
    hue,
    sides: AGENT_SIDES[card.agentType] ?? 3,
    dots: Math.min(8, card.errors),
    rotation: hashId(card.id),
    ringWidth: totalTokens < 10_000 ? 1.5 : totalTokens < 100_000 ? 2.2 : 3,
    glow: totalTokens < 10_000 ? 0 : totalTokens < 100_000 ? 1.5 : 2.5
  }
}

/** 内芯多边形顶点（40×40 viewBox，中心 20,20，半径 r） */
export function polygonPoints(sides: number, r: number, rotationDeg: number): string {
  const pts: string[] = []
  for (let i = 0; i < sides; i++) {
    const a = ((i / sides) * 360 + rotationDeg - 90) * (Math.PI / 180)
    pts.push(`${(20 + r * Math.cos(a)).toFixed(1)},${(20 + r * Math.sin(a)).toFixed(1)}`)
  }
  return pts.join(' ')
}
