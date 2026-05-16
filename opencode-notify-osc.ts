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

// Check if running inside tmux
const IS_TMUX = process.env.TMUX !== undefined

// OSC 9: terminal notification sequence
// Format: ESC ] 9 ; message BEL
// In tmux, wrap with tmux passthrough sequence: ESC P tmux ; ESC <seq> ESC \
const OSC_NOTIFY = (message: string) => {
  const seq = `\x1b]9;${message}\x07`
  if (IS_TMUX) {
    return `\x1bPtmux;\x1b${seq}\x1b\\`
  }
  return seq
}

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

export const NotifyOscPlugin: Plugin = async (ctx) => {
  const { client } = ctx

  // Load config once at startup
  const config = await loadConfig()

  // Logger using SDK app.log API (avoids console output that breaks TUI)
  const logger = {
    debug: (message: string, extra?: Record<string, unknown>) =>
      client.app.log({
        body: { service: "notify-osc", level: "debug", message, extra },
      }).catch(() => {}),
    info: (message: string, extra?: Record<string, unknown>) =>
      client.app.log({
        body: { service: "notify-osc", level: "info", message, extra },
      }).catch(() => {}),
    warn: (message: string, extra?: Record<string, unknown>) =>
      client.app.log({
        body: { service: "notify-osc", level: "warn", message, extra },
      }).catch(() => {}),
    error: (message: string, extra?: Record<string, unknown>) =>
      client.app.log({
        body: { service: "notify-osc", level: "error", message, extra },
      }).catch(() => {}),
  }

  logger.debug("Plugin initialized", {
    notifyChildSessions: config.notifyChildSessions,
    titlePrefix: config.titlePrefix,
    quietHours: config.quietHours,
  })

  const state = {
    recentQuestionNotifications: new Map<string, number>(),
    recentReadyNotifications: new Map<string, number>(),
    recentPermissionNotifications: new Map<string, number>(),
  }

  const isTmux = !!process.env.TMUX

  const sendOsc = (message: string) => {
    try {
      process.stderr.write(OSC_NOTIFY(message))

      if (isTmux) {
        process.stderr.write("\x07")
      }
    } catch (err) {
      logger.error("Failed to send OSC notification", { message, error: String(err) })
    }
  }

  // Check if session is a parent session (no parentID)
  async function isParentSession(sessionID: string): Promise<boolean> {
    try {
      const session = await client.session.get({ path: { id: sessionID } })
      return !session.data?.parentID
    } catch {
      return true
    }
  }

  // --- Event Handlers (replicated from opencode-notify) ---

  async function handleSessionIdle(sessionID: string): Promise<void> {
    logger.debug("handleSessionIdle", { sessionID })

    if (!config.notifyChildSessions) {
      const isParent = await isParentSession(sessionID)
      logger.debug("isParentSession check", { sessionID, isParent })
      if (!isParent) return
    }

    if (isQuietHours(config)) {
      logger.debug("Quiet hours active, skipping", { sessionID })
      return
    }

    const dedupeKey = buildSessionReadyDedupeKey(sessionID)
    if (!dedupeKey) return

    if (
      !shouldSendDedupedNotification(
        state.recentReadyNotifications,
        dedupeKey,
        READY_DEDUPE_MS,
      )
    ) {
      logger.debug("Deduped, skipping session idle", { sessionID, dedupeKey })
      return
    }

    let sessionTitle = "Task"
    try {
      const session = await client.session.get({ path: { id: sessionID } })
      if (session.data?.title) {
        sessionTitle = session.data.title.slice(0, 50)
      }
    } catch (err) {
      logger.warn("Failed to get session title", { sessionID, error: String(err) })
    }

    const message = `${config.titlePrefix}: Ready for review - ${sessionTitle}`
    logger.debug("Sending OSC notification", { message, type: "session.idle" })
    sendOsc(message)
  }

  async function handleSessionError(sessionID: string, error?: string): Promise<void> {
    logger.debug("handleSessionError", { sessionID, error })

    if (!config.notifyChildSessions) {
      const isParent = await isParentSession(sessionID)
      if (!isParent) return
    }

    if (isQuietHours(config)) return

    const errorMessage = error?.slice(0, 100) || "Something went wrong"
    const message = `${config.titlePrefix}: Something went wrong - ${errorMessage}`
    logger.debug("Sending OSC notification", { message, type: "session.error" })
    sendOsc(message)
  }

  async function handlePermissionAsked(permission: { id?: string }): Promise<void> {
    logger.debug("handlePermissionAsked", { permissionID: permission.id })

    const dedupeKey = buildPermissionEventDedupeKey(permission)

    if (
      dedupeKey &&
      !shouldSendDedupedNotification(
        state.recentPermissionNotifications,
        dedupeKey,
        PERMISSION_DEDUPE_MS,
      )
    ) {
      logger.debug("Deduped, skipping permission", { permissionID: permission.id })
      return
    }

    const message = `${config.titlePrefix}: Waiting for you - OpenCode needs your input`
    logger.debug("Sending OSC notification", { message, type: "permission.asked" })
    sendOsc(message)
  }

  async function handleQuestionAsked(dedupeKey: string | null): Promise<void> {
    logger.debug("handleQuestionAsked", { dedupeKey })

    if (
      dedupeKey &&
      !shouldSendDedupedNotification(
        state.recentQuestionNotifications,
        dedupeKey,
        QUESTION_DEDUPE_MS,
      )
    ) {
      logger.debug("Deduped, skipping question", { dedupeKey })
      return
    }

    const message = `${config.titlePrefix}: Question for you - OpenCode needs your input`
    logger.debug("Sending OSC notification", { message, type: "question" })
    sendOsc(message)
  }

  return {
    // Hook: tool.execute.before — detect question tool
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
      logger.debug("tool.execute.before", { tool: input.tool, sessionID: input.sessionID, callID: input.callID })
      if (input.tool === "question") {
        const dedupeKey = buildQuestionToolDedupeKey(input.sessionID, input.callID)
        await handleQuestionAsked(dedupeKey)
      }
    },

    // Hook: event — listen for session/permission events
    event: async ({ event }: { event: Event }) => {
      logger.debug("Event received", { eventType: event.type })

      switch (event.type) {
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

        case "permission.asked": {
          await handlePermissionAsked(event.properties)
          break
        }
      }
    },
  }
}
