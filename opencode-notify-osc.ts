/**
 * opencode-notify-osc
 *
 * OpenCode plugin that sends OSC 9 terminal notifications.
 * Replicates event/hook listening from https://github.com/kdcokenny/opencode-notify
 *
 * Uses OSC 9 escape sequences (compatible with Ghostty, iTerm2, WezTerm, etc.)
 * instead of desktop notifications.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"

// OSC 9: terminal notification sequence
// Format: ESC ] 9 ; message BEL
const OSC_NOTIFY = (message: string) => `\x1b]9;${message}\x07`

// Debounce windows (matching opencode-notify)
const QUESTION_DEDUPE_MS = 1500
const READY_DEDUPE_MS = 1500
const PERMISSION_DEDUPE_MS = 1500

// ==========================================
// CONFIGURATION
// ==========================================

interface OscNotifyConfig {
  /** Notify for child/sub-session events (default: false) */
  notifyChildSessions: boolean
  /** Quiet hours configuration */
  quietHours: {
    enabled: boolean
    start: string // "HH:MM" format
    end: string // "HH:MM" format
  }
  /** Message prefix (default: "OpenCode") */
  titlePrefix: string
}

const DEFAULT_CONFIG: OscNotifyConfig = {
  notifyChildSessions: false,
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "08:00",
  },
  titlePrefix: "OpenCode",
}

async function loadConfig(): Promise<OscNotifyConfig> {
  const configPath = path.join(os.homedir(), ".config", "opencode", "opencode-notify-osc.json")

  try {
    const content = await fs.readFile(configPath, "utf8")
    const userConfig = JSON.parse(content) as Partial<OscNotifyConfig>

    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      quietHours: {
        ...DEFAULT_CONFIG.quietHours,
        ...userConfig.quietHours,
      },
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

// ==========================================
// QUIET HOURS CHECK
// ==========================================

function isQuietHours(config: OscNotifyConfig): boolean {
  if (!config.quietHours.enabled) return false

  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  const [startHour, startMin] = config.quietHours.start.split(":").map(Number)
  const [endHour, endMin] = config.quietHours.end.split(":").map(Number)

  const startMinutes = startHour * 60 + startMin
  const endMinutes = endHour * 60 + endMin

  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// ==========================================
// DEDUPE UTILITIES
// ==========================================

type RecentNotifications = Map<string, number>

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  if (!normalized) return null
  return normalized
}

function shouldSendDedupedNotification(
  recentNotifications: RecentNotifications,
  dedupeKey: string,
  windowMs: number,
  nowMs = Date.now(),
): boolean {
  for (const [key, timestamp] of recentNotifications) {
    if (nowMs - timestamp >= windowMs) {
      recentNotifications.delete(key)
    }
  }

  const lastSentAt = recentNotifications.get(dedupeKey)
  if (lastSentAt !== undefined && nowMs - lastSentAt < windowMs) {
    return false
  }

  recentNotifications.set(dedupeKey, nowMs)
  return true
}

function buildQuestionToolDedupeKey(sessionID: unknown, callID: unknown): string | null {
  const normalizedSessionID = toNonEmptyString(sessionID)
  if (!normalizedSessionID) return null

  const normalizedCallID = toNonEmptyString(callID)
  if (!normalizedCallID) return null

  return `question:${normalizedSessionID}:${normalizedCallID}`
}

function buildSessionReadyDedupeKey(sessionID: unknown): string | null {
  const normalizedSessionID = toNonEmptyString(sessionID)
  if (!normalizedSessionID) return null
  return `session-ready:${normalizedSessionID}`
}

function buildPermissionEventDedupeKey(permission: { id?: string }): string | null {
  const normalizedRequestID = toNonEmptyString(permission.id)
  if (!normalizedRequestID) return null

  return `permission:request:${normalizedRequestID}`
}

// ==========================================
// PLUGIN
// ==========================================

const NotifyOscPlugin: Plugin = async (ctx) => {
  const { client } = ctx

  // Load config once at startup
  const config = await loadConfig()

  const state = {
    recentQuestionNotifications: new Map<string, number>(),
    recentReadyNotifications: new Map<string, number>(),
    recentPermissionNotifications: new Map<string, number>(),
  }

  const sendOsc = (message: string) => {
    process.stderr.write(OSC_NOTIFY(message))
  }

  // Check if session is a parent session (no parentID)
  async function isParentSession(sessionID: string): Promise<boolean> {
    try {
      const session = await client.session.get({ sessionID })
      return !session.data?.parentID
    } catch {
      return true
    }
  }

  // --- Event Handlers (replicated from opencode-notify) ---

  async function handleSessionIdle(sessionID: string): Promise<void> {
    if (!config.notifyChildSessions) {
      const isParent = await isParentSession(sessionID)
      if (!isParent) return
    }

    if (isQuietHours(config)) return

    const dedupeKey = buildSessionReadyDedupeKey(sessionID)
    if (!dedupeKey) return

    if (
      !shouldSendDedupedNotification(
        state.recentReadyNotifications,
        dedupeKey,
        READY_DEDUPE_MS,
      )
    ) {
      return
    }

    let sessionTitle = "Task"
    try {
      const session = await client.session.get({ sessionID })
      if (session.data?.title) {
        sessionTitle = session.data.title.slice(0, 50)
      }
    } catch {
      // use default
    }

    sendOsc(`${config.titlePrefix}: Ready for review - ${sessionTitle}`)
  }

  async function handleSessionError(sessionID: string, error?: string): Promise<void> {
    if (!config.notifyChildSessions) {
      const isParent = await isParentSession(sessionID)
      if (!isParent) return
    }

    if (isQuietHours(config)) return

    const errorMessage = error?.slice(0, 100) || "Something went wrong"
    sendOsc(`${config.titlePrefix}: Something went wrong - ${errorMessage}`)
  }

  async function handlePermissionUpdated(permission: { id?: string }): Promise<void> {
    const dedupeKey = buildPermissionEventDedupeKey(permission)

    if (
      dedupeKey &&
      !shouldSendDedupedNotification(
        state.recentPermissionNotifications,
        dedupeKey,
        PERMISSION_DEDUPE_MS,
      )
    ) {
      return
    }

    sendOsc(`${config.titlePrefix}: Waiting for you - OpenCode needs your input`)
  }

  async function handleQuestionAsked(dedupeKey: string | null): Promise<void> {
    if (
      dedupeKey &&
      !shouldSendDedupedNotification(
        state.recentQuestionNotifications,
        dedupeKey,
        QUESTION_DEDUPE_MS,
      )
    ) {
      return
    }

    sendOsc(`${config.titlePrefix}: Question for you - OpenCode needs your input`)
  }

  return {
    // Hook: tool.execute.before — detect question tool
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
      if (input.tool === "question") {
        const dedupeKey = buildQuestionToolDedupeKey(input.sessionID, input.callID)
        await handleQuestionAsked(dedupeKey)
      }
    },

    // Hook: event — listen for session/permission events
    event: async ({ event }: { event: Event }) => {
      switch (event.type) {
        case "session.status":
        case "session.idle": {
          const sessionID = toNonEmptyString(event.properties.sessionID)
          if (sessionID) {
            await handleSessionIdle(sessionID)
          }
          break
        }

        case "session.error": {
          const sessionID = toNonEmptyString(event.properties.sessionID)
          const error = event.properties.error
          const errorMessage = error?.data?.message
          if (sessionID) {
            await handleSessionError(sessionID, errorMessage)
          }
          break
        }

        case "permission.updated": {
          await handlePermissionUpdated(event.properties)
          break
        }
      }
    },
  }
}

export default NotifyOscPlugin
