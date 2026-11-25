import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { isAllowedHost } from './host-guard.js';
import {
  publicInstance,
  type Instance,
} from './store.js';
import {
  compareSessionFingerprints,
  DisplaySizeMismatchError,
  isInSendButtonZone,
  MIN_HEADER_INK_PIXELS,
  type ClickOptions,
  type EditorCheckMetrics,
  type HeaderCheckMetrics,
  type MouseButton,
  type RuntimeState,
  type ScreenshotCrop,
  type ScreenshotOptions,
  type ScreenshotResult,
  type ScrollDirection,
  type ScrollOptions,
  type SessionFingerprint,
  type TransferFile,
  type TypeOptions,
  type WechatStatus,
  type WechatWindowInfo,
} from './docker.js';
import { DIAG_RANGES, filterSince, rangeToMs } from './logs.js';

const MCP_BODY_LIMIT_BYTES = 256 * 1024; // 256 KiB JSON-RPC payload cap
const DEFAULT_LOG_TAIL = 100;
const MAX_LOG_TAIL = 500;
const MAX_LOG_BYTES = 64 * 1024; // 64 KiB cap on returned log text
const DEFAULT_SCREENSHOT_MAX_WIDTH = 1280;
const MIN_SCREENSHOT_MAX_WIDTH = 320;
const MAX_SCREENSHOT_MAX_WIDTH = 2560;
const MAX_DRAFT_TEXT_CHARS = 500;
const DEFAULT_DRAFT_TTL_MS = 60_000;
const MAX_DRAFT_ENTRIES = 32;
const DEFAULT_WRITE_WINDOW_MS = 60_000;
const DEFAULT_WRITE_MAX_PER_WINDOW = 20;
const DEFAULT_SEND_WINDOW_MS = 60_000;
const DEFAULT_SEND_MAX_PER_WINDOW = 3;
const DEFAULT_SEND_MIN_INTERVAL_MS = 3_000;

export interface ControlLockInfo {
  active: boolean;
  holder: string | null;
  ageMs: number | null;
}

export interface WriteRateLimitConfig {
  writeWindowMs?: number;
  writeMaxPerWindow?: number;
  sendWindowMs?: number;
  sendMaxPerWindow?: number;
  sendMinIntervalMs?: number;
}

export interface McpDeps {
  authToken?: string;
  allowWrite?: boolean;
  allowedHosts: string[];
  panelVersion: string;
  buildRevision: string | null;
  dockerHealthy: () => Promise<boolean>;
  listInstances: () => Instance[];
  findInstance: (id: string) => Instance | undefined;
  instanceRuntime: (inst: Instance) => Promise<RuntimeState>;
  instanceUptimeSec: (inst: Instance) => Promise<number | null>;
  instanceMemoryMB: (inst: Instance) => Promise<number>;
  instanceHttpHealthy: (inst: Instance) => Promise<boolean>;
  wechatStatus: (inst: Instance) => Promise<WechatStatus>;
  instanceLogs: (inst: Instance, tail?: number) => Promise<string>;
  readInstanceLog: (id: string) => string;
  listInstanceFiles: (inst: Instance) => Promise<TransferFile[]>;
  wechatWindowInfo: (inst: Instance) => Promise<WechatWindowInfo>;
  captureInstanceScreenshot: (inst: Instance, opts?: ScreenshotOptions) => Promise<ScreenshotResult>;
  clickInInstance?: (inst: Instance, opts: ClickOptions) => Promise<{ displayWidth: number; displayHeight: number }>;
  scrollInInstance?: (inst: Instance, opts: ScrollOptions) => Promise<{ displayWidth: number; displayHeight: number }>;
  typeInInstance?: (inst: Instance, text: string, opts?: TypeOptions) => Promise<void>;
  clearInputInInstance?: (inst: Instance) => Promise<void>;
  keyInInstance?: (inst: Instance, key: string) => Promise<void>;
  captureSessionFingerprint?: (inst: Instance) => Promise<SessionFingerprint>;
  effectiveLimits: (inst: Instance) => { soft: number; hard: number };
  activeVncViewerCount: (id: string) => number;
  getControlLock: (id: string) => ControlLockInfo;
  hasActiveSession: (id: string) => boolean;
  draftTtlMs?: number;
  editorMaxDiffPixels?: number | null;
  rateLimits?: WriteRateLimitConfig;
  now?: () => number;
  log?: (line: string) => void;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_NON_DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const WRITE_IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const MCP_TOOLS: Tool[] = [
  {
    name: 'woc_health',
    description:
      'Check WechatOnCloud panel health, version/revision, Docker socket proxy connectivity (docker.ping), and running/stopped instance counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'woc_list_instances',
    description:
      'List all configured WOC instances with sanitized metadata (no secrets), runtime state, uptime, memory usage, active VNC viewer count, and control lock holder. Never starts stopped containers.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'woc_instance_status',
    description:
      'Get detailed read-only status for a single WOC instance (runtime state, uptime, memory MB vs watchdog soft/hard limits, VNC HTTP health, WeChat status, active VNC viewers, control lock). Returns instance_stopped cleanly when stopped.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID (from woc_list_instances).',
        },
      },
      required: ['instance_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'woc_get_logs',
    description:
      'Read recent container logs (and optional persistent history) for a WOC instance, capped in lines and bytes. When the instance is stopped, live logs are omitted with instance_stopped=true and containers are never started.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID (from woc_list_instances).',
        },
        tail: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LOG_TAIL,
          description: `Number of live log lines to fetch (default ${DEFAULT_LOG_TAIL}, max ${MAX_LOG_TAIL}).`,
        },
        include_history: {
          type: 'boolean',
          description: 'Include persistent panel-side instance history log (default false).',
        },
        range: {
          type: 'string',
          enum: ['24h', '7d', '30d', '1y'],
          description: 'Optional time window filter when include_history is true (default 24h).',
        },
      },
      required: ['instance_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'woc_list_files',
    description:
      'List files currently in the instance transfer folder (~/Desktop). Returns instance_stopped cleanly if the instance is not running.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID (from woc_list_instances).',
        },
      },
      required: ['instance_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'woc_window_info',
    description:
      'Read X11 display resolution and visible WeChat main window geometry/title inside a running instance. Returns instance_stopped cleanly if stopped.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID (from woc_list_instances).',
        },
      },
      required: ['instance_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'woc_screenshot',
    description:
      'Capture an in-memory PNG screenshot of a running instance X11 display (never written to disk, never starts stopped containers). Returns an MCP image block plus JSON metadata including display/image dimensions and WeChat window geometry.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID (from woc_list_instances).',
        },
        max_width: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_SCREENSHOT_MAX_WIDTH,
          description: `Target max image width in pixels (default ${DEFAULT_SCREENSHOT_MAX_WIDTH}; 0 for full native resolution; otherwise ${MIN_SCREENSHOT_MAX_WIDTH}-${MAX_SCREENSHOT_MAX_WIDTH}).`,
        },
        full_resolution: {
          type: 'boolean',
          description: 'When true, capture at full native display width without downscaling (overrides max_width).',
        },
        crop: {
          type: 'object',
          description: 'Optional crop rectangle in native X11 display coordinates (clamped to display bounds).',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      required: ['instance_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
];

export const MCP_WRITE_TOOLS: Tool[] = [
  {
    name: 'woc_click',
    description:
      'Click at native X11 display coordinates (NOT scaled screenshot coordinates) inside a running WOC instance. Rejects if live display dimensions do not match display_width/display_height, if a human is viewing/controlling VNC, or if stopped. Clicking WeChat bottom-right Send button to bypass woc_draft_reply + woc_confirm_send is prohibited and blocked (send_button_click_blocked). Invalidates any pending drafts for this instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID (from woc_list_instances).',
        },
        x: {
          type: 'number',
          description: 'Target X coordinate in native X11 display pixels.',
        },
        y: {
          type: 'number',
          description: 'Target Y coordinate in native X11 display pixels.',
        },
        display_width: {
          type: 'integer',
          minimum: 1,
          description: 'Expected live X11 display width (must match current display).',
        },
        display_height: {
          type: 'integer',
          minimum: 1,
          description: 'Expected live X11 display height (must match current display).',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to click (default left).',
        },
        double_click: {
          type: 'boolean',
          description: 'Perform a double click when true (default false).',
        },
      },
      required: ['instance_id', 'x', 'y', 'display_width', 'display_height'],
      additionalProperties: false,
    },
    annotations: WRITE_NON_DESTRUCTIVE_ANNOTATIONS,
  },
  {
    name: 'woc_scroll',
    description:
      'Scroll at native X11 display coordinates inside a running WOC instance. Rejects if live display dimensions do not match display_width/display_height, if a human is viewing/controlling VNC, or if stopped. Invalidates any pending drafts for this instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID (from woc_list_instances).',
        },
        x: {
          type: 'number',
          description: 'Pointer X coordinate in native X11 display pixels.',
        },
        y: {
          type: 'number',
          description: 'Pointer Y coordinate in native X11 display pixels.',
        },
        display_width: {
          type: 'integer',
          minimum: 1,
          description: 'Expected live X11 display width (must match current display).',
        },
        display_height: {
          type: 'integer',
          minimum: 1,
          description: 'Expected live X11 display height (must match current display).',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction.',
        },
        clicks: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Number of wheel steps (1..20, default 3).',
        },
      },
      required: ['instance_id', 'x', 'y', 'display_width', 'display_height', 'direction'],
      additionalProperties: false,
    },
    annotations: WRITE_NON_DESTRUCTIVE_ANNOTATIONS,
  },
  {
    name: 'woc_draft_reply',
    description:
      'Clear any residual text in the active WeChat chat editor and paste draft reply text (focusChat=true, clearFirst=true, NEVER presses Return), capture an atomic header+editor grayscale fingerprint and post-paste verification screenshot, and return a short-lived single-use draft_id for woc_confirm_send.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID (from woc_list_instances).',
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_DRAFT_TEXT_CHARS,
          description: `Draft message text to paste into WeChat editor (1..${MAX_DRAFT_TEXT_CHARS} chars; clears existing input first, never sent automatically).`,
        },
        max_width: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_SCREENSHOT_MAX_WIDTH,
          description: `Target max width for the post-paste verification screenshot (default ${DEFAULT_SCREENSHOT_MAX_WIDTH}; 0 for native; or ${MIN_SCREENSHOT_MAX_WIDTH}-${MAX_SCREENSHOT_MAX_WIDTH}).`,
        },
        full_resolution: {
          type: 'boolean',
          description: 'Capture post-paste verification screenshot at full native width.',
        },
      },
      required: ['instance_id', 'text'],
      additionalProperties: false,
    },
    annotations: WRITE_NON_DESTRUCTIVE_ANNOTATIONS,
  },
  {
    name: 'woc_confirm_send',
    description:
      'Consume a single-use draft_id from woc_draft_reply, re-verify runtime/human-control/window geometry/header+editor fingerprints, and press Return once to send the drafted WeChat reply. Never retries on error and never re-pastes.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID matching the draft.',
        },
        draft_id: {
          type: 'string',
          description: 'Single-use draft_id returned by woc_draft_reply.',
        },
      },
      required: ['instance_id', 'draft_id'],
      additionalProperties: false,
    },
    annotations: WRITE_DESTRUCTIVE_ANNOTATIONS,
  },
  {
    name: 'woc_discard_draft',
    description:
      'Invalidate all pending unconsumed draft_ids for an instance and clear any residual text in the active WeChat chat input box (ctrl+a + BackSpace, never presses Return).',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Instance ID whose pending drafts and chat input box should be cleared.',
        },
      },
      required: ['instance_id'],
      additionalProperties: false,
    },
    annotations: WRITE_IDEMPOTENT_ANNOTATIONS,
  },
];

// ---------- Bounded In-Memory Draft Store (NEVER stores message plaintext) ----------
interface DraftEntry {
  draftId: string;
  instanceId: string;
  createdAt: number;
  expiresAt: number;
  textLength: number;
  fingerprint: SessionFingerprint;
}

class DraftStore {
  private readonly entries = new Map<string, DraftEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DRAFT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? MAX_DRAFT_ENTRIES;
    this.now = opts.now ?? (() => Date.now());
  }

  private prune(ts: number): void {
    for (const [id, entry] of this.entries) {
      if (ts > entry.expiresAt) this.entries.delete(id);
    }
  }

  create(instanceId: string, textLength: number, fingerprint: SessionFingerprint): DraftEntry {
    const ts = this.now();
    this.prune(ts);
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    const draftId = randomBytes(16).toString('hex');
    const entry: DraftEntry = {
      draftId,
      instanceId,
      createdAt: ts,
      expiresAt: ts + this.ttlMs,
      textLength,
      fingerprint,
    };
    this.entries.set(draftId, entry);
    return entry;
  }

  // Atomically look up and delete so draft_id can NEVER be reused even on mismatch/failure.
  consume(draftId: string): DraftEntry | null {
    const entry = this.entries.get(draftId) ?? null;
    if (entry) this.entries.delete(draftId);
    return entry;
  }

  // Invalidate all unconsumed drafts for a specific instance (called after click/scroll/discard).
  invalidateInstance(instanceId: string): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (entry.instanceId === instanceId) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }
}

// ---------- Sliding-Window Write Rate Limiter ----------
class WriteRateLimiter {
  private readonly writeHits: number[] = [];
  private readonly sendHits: number[] = [];
  private readonly writeWindowMs: number;
  private readonly writeMax: number;
  private readonly sendWindowMs: number;
  private readonly sendMax: number;
  private readonly sendMinIntervalMs: number;
  private readonly now: () => number;

  constructor(cfg: WriteRateLimitConfig = {}, now: () => number = () => Date.now()) {
    this.writeWindowMs = cfg.writeWindowMs ?? DEFAULT_WRITE_WINDOW_MS;
    this.writeMax = cfg.writeMaxPerWindow ?? DEFAULT_WRITE_MAX_PER_WINDOW;
    this.sendWindowMs = cfg.sendWindowMs ?? DEFAULT_SEND_WINDOW_MS;
    this.sendMax = cfg.sendMaxPerWindow ?? DEFAULT_SEND_MAX_PER_WINDOW;
    this.sendMinIntervalMs = cfg.sendMinIntervalMs ?? DEFAULT_SEND_MIN_INTERVAL_MS;
    this.now = now;
  }

  private prune(arr: number[], windowMs: number, ts: number): void {
    const cutoff = ts - windowMs;
    while (arr.length > 0 && arr[0] <= cutoff) arr.shift();
  }

  checkAndRecord(isConfirmSend: boolean): { allowed: true } | { allowed: false; retryAfterMs: number; scope: 'write' | 'confirm_send' } {
    const ts = this.now();
    this.prune(this.writeHits, this.writeWindowMs, ts);
    this.prune(this.sendHits, this.sendWindowMs, ts);

    if (isConfirmSend) {
      if (this.sendHits.length > 0) {
        const elapsed = ts - this.sendHits[this.sendHits.length - 1];
        if (elapsed < this.sendMinIntervalMs) {
          return {
            allowed: false,
            retryAfterMs: Math.max(1, this.sendMinIntervalMs - elapsed),
            scope: 'confirm_send',
          };
        }
      }
      if (this.sendHits.length >= this.sendMax) {
        return {
          allowed: false,
          retryAfterMs: Math.max(1, this.sendHits[0] + this.sendWindowMs - ts),
          scope: 'confirm_send',
        };
      }
    }

    if (this.writeHits.length >= this.writeMax) {
      return {
        allowed: false,
        retryAfterMs: Math.max(1, this.writeHits[0] + this.writeWindowMs - ts),
        scope: 'write',
      };
    }

    this.writeHits.push(ts);
    if (isConfirmSend) this.sendHits.push(ts);
    return { allowed: true };
  }
}

// Constant-time, length-safe Bearer token verification using SHA-256 digests.
export function verifyBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader || !expectedToken) return false;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authHeader);
  if (!match) return false;
  const providedHash = createHash('sha256').update(match[1], 'utf8').digest();
  const expectedHash = createHash('sha256').update(expectedToken, 'utf8').digest();
  return timingSafeEqual(providedHash, expectedHash);
}

// Per MCP Streamable HTTP spec, reject unexpected browser Origin headers.
// Non-browser MCP clients omit Origin, which is allowed.
export function isOriginAllowed(originHeader: string | undefined, allowedHosts: string[]): boolean {
  if (originHeader === undefined) return true;
  const trimmed = originHeader.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isAllowedHost(parsed.hostname.toLowerCase(), allowedHosts);
}

function jsonTextResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function requireInstanceId(args: Record<string, unknown>): string {
  const id = args.instance_id;
  if (typeof id !== 'string' || !id.trim() || id.length > 64) {
    throw new Error('invalid_argument: instance_id must be a non-empty string');
  }
  return id.trim();
}

function requireFiniteNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`invalid_argument: ${key} must be a finite number`);
  }
  return v;
}

function requirePositiveInt(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new Error(`invalid_argument: ${key} must be a positive integer`);
  }
  return v;
}

function truncateTailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  // Keep the most recent tail bytes; slice at a clean UTF-8 boundary.
  let slice = buf.subarray(buf.length - maxBytes);
  let start = 0;
  while (start < slice.length && (slice[start] & 0xc0) === 0x80) start++;
  slice = slice.subarray(start);
  return { text: slice.toString('utf8'), truncated: true };
}

function parseScreenshotArgs(args: Record<string, unknown>, allowCrop = true): ScreenshotOptions {
  const fullResolution = args.full_resolution === true;
  let maxWidth = DEFAULT_SCREENSHOT_MAX_WIDTH;
  if (fullResolution) {
    maxWidth = 0;
  } else if (args.max_width !== undefined) {
    if (typeof args.max_width !== 'number' || !Number.isInteger(args.max_width)) {
      throw new Error('invalid_argument: max_width must be an integer');
    }
    if (args.max_width === 0) {
      maxWidth = 0;
    } else if (args.max_width < MIN_SCREENSHOT_MAX_WIDTH || args.max_width > MAX_SCREENSHOT_MAX_WIDTH) {
      throw new Error(
        `invalid_argument: max_width must be 0 or between ${MIN_SCREENSHOT_MAX_WIDTH} and ${MAX_SCREENSHOT_MAX_WIDTH}`,
      );
    } else {
      maxWidth = args.max_width;
    }
  }

  let crop: ScreenshotCrop | undefined;
  if (allowCrop && args.crop !== undefined) {
    if (!args.crop || typeof args.crop !== 'object' || Array.isArray(args.crop)) {
      throw new Error('invalid_argument: crop must be an object { x, y, width, height }');
    }
    const c = args.crop as Record<string, unknown>;
    if (
      typeof c.x !== 'number' || !Number.isFinite(c.x) ||
      typeof c.y !== 'number' || !Number.isFinite(c.y) ||
      typeof c.width !== 'number' || !Number.isFinite(c.width) || c.width <= 0 ||
      typeof c.height !== 'number' || !Number.isFinite(c.height) || c.height <= 0
    ) {
      throw new Error('invalid_argument: crop requires finite numbers x, y and positive width, height');
    }
    crop = { x: c.x, y: c.y, width: c.width, height: c.height };
  }

  return { maxWidth, crop };
}

interface McpRuntimeState {
  allowWrite: boolean;
  draftStore: DraftStore;
  rateLimiter: WriteRateLimiter;
  now: () => number;
}

function createMcpServer(deps: McpDeps, state: McpRuntimeState): Server {
  const log = deps.log ?? ((line: string) => console.log(line));
  const activeTools = state.allowWrite ? [...MCP_TOOLS, ...MCP_WRITE_TOOLS] : MCP_TOOLS;

  const auditWrite = (entry: {
    tool: string;
    instance_id: string;
    text_length?: number;
    result: 'ok' | 'rejected' | 'error';
    error?: string;
    duration_ms: number;
  }) => {
    // Privacy: NEVER log message plaintext, screenshots/base64, or tokens.
    log(`[mcp-audit] ${JSON.stringify({ ts: new Date(state.now()).toISOString(), ...entry })}`);
  };

  // Shared pre-execution guardrail for all 4 write tools.
  const checkWriteGuards = async (
    inst: Instance,
    isConfirmSend: boolean,
  ): Promise<
    | { ok: true }
    | { ok: false; error: string; payload: Record<string, unknown> }
  > => {
    const runtime = await deps.instanceRuntime(inst);
    if (runtime !== 'running') {
      return {
        ok: false,
        error: 'instance_stopped',
        payload: {
          ok: false,
          error: 'instance_stopped',
          instance_id: inst.id,
          runtime,
          message: 'Instance is not running; MCP will not start stopped containers.',
        },
      };
    }

    const viewers = deps.activeVncViewerCount(inst.id);
    const controlLock = deps.getControlLock(inst.id);
    if (viewers > 0 || controlLock.active) {
      return {
        ok: false,
        error: 'human_in_control',
        payload: {
          ok: false,
          error: 'human_in_control',
          instance_id: inst.id,
          active_vnc_viewers: viewers,
          control_lock: controlLock,
          message: 'A human is currently viewing or controlling this instance; write action aborted.',
        },
      };
    }

    const rate = state.rateLimiter.checkAndRecord(isConfirmSend);
    if (!rate.allowed) {
      return {
        ok: false,
        error: 'rate_limited',
        payload: {
          ok: false,
          error: 'rate_limited',
          instance_id: inst.id,
          limit_scope: rate.scope,
          retry_after_ms: rate.retryAfterMs,
          message: `Write rate limit exceeded (${rate.scope}); retry after ${rate.retryAfterMs}ms.`,
        },
      };
    }

    return { ok: true };
  };

  const server = new Server(
    {
      name: 'woc-panel-mcp',
      version: deps.panelVersion || 'dev',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: state.allowWrite
        ? 'MCP server for WechatOnCloud (WOC) with controlled write tools enabled. Never assumes stopped instances can be started. Always inspect screenshot/window info before clicking; always review woc_draft_reply screenshot and obtain explicit user approval before calling woc_confirm_send.'
        : 'Read-only MCP server for WechatOnCloud (WOC). Never assumes stopped instances can be started; check runtime state first.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawArgs = request.params.arguments;
    const args: Record<string, unknown> =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const t0 = state.now();
    let logInstanceId = '-';
    const isWriteTool =
      toolName === 'woc_click' ||
      toolName === 'woc_scroll' ||
      toolName === 'woc_draft_reply' ||
      toolName === 'woc_confirm_send' ||
      toolName === 'woc_discard_draft';

    // Strict feature gate: when MCP_ALLOW_WRITE !== '1', write tools behave as unknown tools.
    if (isWriteTool && !state.allowWrite) {
      log(`[mcp] tool=${toolName} instanceId=- durationMs=${state.now() - t0} ok=false reason=unknown_tool`);
      return jsonTextResult({ ok: false, error: 'unknown_tool', tool: toolName }, true);
    }

    try {
      switch (toolName) {
        case 'woc_health': {
          const instances = deps.listInstances();
          const [socketProxyOk, runtimes] = await Promise.all([
            deps.dockerHealthy(),
            Promise.all(instances.map((i) => deps.instanceRuntime(i))),
          ]);
          const counts = { total: instances.length, running: 0, stopped: 0, missing: 0 };
          for (const rt of runtimes) counts[rt]++;
          const payload = {
            ok: true,
            panel: {
              version: deps.panelVersion,
              revision: deps.buildRevision,
              uptime_sec: Math.round(process.uptime()),
            },
            socket_proxy_ok: socketProxyOk,
            instances: counts,
          };
          log(`[mcp] tool=${toolName} instanceId=- durationMs=${state.now() - t0} ok=true`);
          return jsonTextResult(payload);
        }

        case 'woc_list_instances': {
          const instances = deps.listInstances();
          const out = await Promise.all(
            instances.map(async (inst) => {
              const runtime = await deps.instanceRuntime(inst);
              const [uptimeSec, memoryMB] =
                runtime === 'running'
                  ? await Promise.all([deps.instanceUptimeSec(inst), deps.instanceMemoryMB(inst)])
                  : [null, null];
              return {
                ...publicInstance(inst),
                runtime,
                instance_stopped: runtime !== 'running',
                uptime_sec: uptimeSec !== null ? Math.round(uptimeSec) : null,
                memory_mb: memoryMB,
                active_vnc_viewers: deps.activeVncViewerCount(inst.id),
                control_lock: deps.getControlLock(inst.id),
              };
            }),
          );
          log(`[mcp] tool=${toolName} instanceId=- count=${out.length} durationMs=${state.now() - t0} ok=true`);
          return jsonTextResult({ ok: true, instances: out });
        }

        case 'woc_instance_status': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const inst = deps.findInstance(id);
          if (!inst) {
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${state.now() - t0} ok=false reason=not_found`);
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }
          const runtime = await deps.instanceRuntime(inst);
          const limits = deps.effectiveLimits(inst);
          const viewers = deps.activeVncViewerCount(inst.id);
          const controlLock = deps.getControlLock(inst.id);
          const activeSession = deps.hasActiveSession(inst.id);

          if (runtime !== 'running') {
            const payload = {
              ok: true,
              instance: publicInstance(inst),
              runtime,
              instance_stopped: true,
              uptime_sec: null,
              memory_mb: null,
              watchdog_limits_mb: limits,
              vnc_http_healthy: false,
              wechat: null,
              active_vnc_viewers: viewers,
              control_lock: controlLock,
              has_active_session: activeSession,
              message: 'Instance is not running; MCP does not start stopped containers.',
            };
            log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} durationMs=${state.now() - t0} ok=true`);
            return jsonTextResult(payload);
          }

          const [uptimeSec, memoryMB, vncHealthy, wx] = await Promise.all([
            deps.instanceUptimeSec(inst),
            deps.instanceMemoryMB(inst),
            deps.instanceHttpHealthy(inst),
            deps.wechatStatus(inst),
          ]);
          const payload = {
            ok: true,
            instance: publicInstance(inst),
            runtime,
            instance_stopped: false,
            uptime_sec: uptimeSec !== null ? Math.round(uptimeSec) : null,
            memory_mb: memoryMB,
            watchdog_limits_mb: limits,
            vnc_http_healthy: vncHealthy,
            wechat: wx,
            active_vnc_viewers: viewers,
            control_lock: controlLock,
            has_active_session: activeSession,
          };
          log(`[mcp] tool=${toolName} instanceId=${id} runtime=running durationMs=${state.now() - t0} ok=true`);
          return jsonTextResult(payload);
        }

        case 'woc_get_logs': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const inst = deps.findInstance(id);
          if (!inst) {
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${state.now() - t0} ok=false reason=not_found`);
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }
          let tail = DEFAULT_LOG_TAIL;
          if (args.tail !== undefined) {
            if (typeof args.tail !== 'number' || !Number.isInteger(args.tail) || args.tail < 1) {
              throw new Error(`invalid_argument: tail must be an integer between 1 and ${MAX_LOG_TAIL}`);
            }
            tail = Math.min(args.tail, MAX_LOG_TAIL);
          }
          const includeHistory = args.include_history === true;
          const range = typeof args.range === 'string' ? args.range : '24h';
          if (includeHistory && !DIAG_RANGES[range]) {
            throw new Error('invalid_argument: range must be one of 24h, 7d, 30d, 1y');
          }

          const runtime = await deps.instanceRuntime(inst);
          let live: string | null = null;
          let liveTruncated = false;
          if (runtime === 'running') {
            const rawLive = (await deps.instanceLogs(inst, tail)).trimEnd();
            const capped = truncateTailBytes(rawLive, MAX_LOG_BYTES);
            live = capped.text;
            liveTruncated = capped.truncated;
          }

          let history: string | undefined;
          let historyTruncated: boolean | undefined;
          if (includeHistory) {
            const since = state.now() - rangeToMs(range);
            const filtered = filterSince(deps.readInstanceLog(inst.id), since).trimEnd();
            const capped = truncateTailBytes(filtered, MAX_LOG_BYTES);
            history = capped.text;
            historyTruncated = capped.truncated;
          }

          const payload = {
            ok: true,
            instance_id: inst.id,
            runtime,
            instance_stopped: runtime !== 'running',
            tail,
            live,
            live_truncated: liveTruncated,
            ...(includeHistory ? { range, history, history_truncated: historyTruncated } : {}),
          };
          log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} tail=${tail} durationMs=${state.now() - t0} ok=true`);
          return jsonTextResult(payload);
        }

        case 'woc_list_files': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const inst = deps.findInstance(id);
          if (!inst) {
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${state.now() - t0} ok=false reason=not_found`);
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }
          const runtime = await deps.instanceRuntime(inst);
          if (runtime !== 'running') {
            log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} durationMs=${state.now() - t0} ok=false reason=instance_stopped`);
            return jsonTextResult({
              ok: false,
              error: 'instance_stopped',
              instance_id: inst.id,
              runtime,
              message: 'Instance is not running; cannot list ~/Desktop files without starting the container.',
            });
          }
          const files = await deps.listInstanceFiles(inst);
          log(`[mcp] tool=${toolName} instanceId=${id} files=${files.length} durationMs=${state.now() - t0} ok=true`);
          return jsonTextResult({
            ok: true,
            instance_id: inst.id,
            directory: '~/Desktop',
            files,
          });
        }

        case 'woc_window_info': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const inst = deps.findInstance(id);
          if (!inst) {
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${state.now() - t0} ok=false reason=not_found`);
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }
          const runtime = await deps.instanceRuntime(inst);
          if (runtime !== 'running') {
            log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} durationMs=${state.now() - t0} ok=false reason=instance_stopped`);
            return jsonTextResult({
              ok: false,
              error: 'instance_stopped',
              instance_id: inst.id,
              runtime,
              message: 'Instance is not running; cannot query X11 window info without starting the container.',
            });
          }
          const info = await deps.wechatWindowInfo(inst);
          log(
            `[mcp] tool=${toolName} instanceId=${id} display=${info.displayWidth}x${info.displayHeight} hasWechat=${Boolean(info.wechatWindow)} durationMs=${state.now() - t0} ok=true`,
          );
          return jsonTextResult({
            ok: true,
            instance_id: inst.id,
            display_width: info.displayWidth,
            display_height: info.displayHeight,
            wechat_window: info.wechatWindow,
          });
        }

        case 'woc_screenshot': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const opts = parseScreenshotArgs(args);
          const inst = deps.findInstance(id);
          if (!inst) {
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${state.now() - t0} ok=false reason=not_found`);
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }
          const runtime = await deps.instanceRuntime(inst);
          if (runtime !== 'running') {
            log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} durationMs=${state.now() - t0} ok=false reason=instance_stopped`);
            return jsonTextResult({
              ok: false,
              error: 'instance_stopped',
              instance_id: inst.id,
              runtime,
              message: 'Instance is not running; cannot capture screenshot without starting the container.',
            });
          }
          const shot = await deps.captureInstanceScreenshot(inst, opts);
          const regionLabel = shot.crop
            ? `${shot.crop.x},${shot.crop.y},${shot.crop.width}x${shot.crop.height}`
            : 'full';
          // Privacy: log metadata ONLY — never log image bytes or base64 data.
          log(
            `[mcp] tool=${toolName} instanceId=${id} region=${regionLabel} dims=${shot.imageWidth}x${shot.imageHeight} bytes=${shot.bytes} durationMs=${shot.durationMs} ok=true`,
          );
          return {
            content: [
              {
                type: 'image' as const,
                data: shot.png.toString('base64'),
                mimeType: 'image/png',
              },
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  instance_id: inst.id,
                  display_width: shot.displayWidth,
                  display_height: shot.displayHeight,
                  image_width: shot.imageWidth,
                  image_height: shot.imageHeight,
                  bytes: shot.bytes,
                  max_width: shot.maxWidth,
                  crop: shot.crop,
                  wechat_window: shot.wechatWindow,
                }),
              },
            ],
          };
        }

        // ---------- Phase 2 Controlled Write Tools (gated by MCP_ALLOW_WRITE=1) ----------
        case 'woc_click': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const x = Math.round(requireFiniteNumber(args, 'x'));
          const y = Math.round(requireFiniteNumber(args, 'y'));
          const displayWidth = requirePositiveInt(args, 'display_width');
          const displayHeight = requirePositiveInt(args, 'display_height');
          const buttonRaw = args.button === undefined ? 'left' : args.button;
          if (buttonRaw !== 'left' && buttonRaw !== 'right' && buttonRaw !== 'middle') {
            throw new Error('invalid_argument: button must be left, right, or middle');
          }
          const button: MouseButton = buttonRaw;
          const doubleClick = args.double_click === true;

          const inst = deps.findInstance(id);
          if (!inst) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'instance_not_found', duration_ms: state.now() - t0 });
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }

          if (x < 0 || x >= displayWidth || y < 0 || y >= displayHeight) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'coordinates_out_of_bounds', duration_ms: state.now() - t0 });
            return jsonTextResult(
              {
                ok: false,
                error: 'coordinates_out_of_bounds',
                instance_id: id,
                x,
                y,
                display_width: displayWidth,
                display_height: displayHeight,
              },
              true,
            );
          }

          const guard = await checkWriteGuards(inst, false);
          if (!guard.ok) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: guard.error, duration_ms: state.now() - t0 });
            return jsonTextResult(guard.payload);
          }

          // Re-verify live display dimensions before clicking.
          const liveWin = await deps.wechatWindowInfo(inst);
          if (liveWin.displayWidth !== displayWidth || liveWin.displayHeight !== displayHeight) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'display_size_mismatch', duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: false,
              error: 'display_size_mismatch',
              instance_id: id,
              expected_display_width: displayWidth,
              expected_display_height: displayHeight,
              actual_display_width: liveWin.displayWidth,
              actual_display_height: liveWin.displayHeight,
            });
          }

          // Low-cost guard: block clicks inside WeChat's bottom-right Send button zone.
          if (isInSendButtonZone(x, y, liveWin.wechatWindow)) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'send_button_click_blocked', duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: false,
              error: 'send_button_click_blocked',
              instance_id: id,
              x,
              y,
              message:
                'Clicking inside WeChat bottom-right Send button zone is blocked by woc_click; use woc_draft_reply followed by woc_confirm_send.',
            });
          }

          if (!deps.clickInInstance) throw new Error('clickInInstance handler not configured');
          try {
            const actual = await deps.clickInInstance(inst, {
              x,
              y,
              displayWidth,
              displayHeight,
              button,
              doubleClick,
            });
            const invalidatedDrafts = state.draftStore.invalidateInstance(inst.id);
            auditWrite({ tool: toolName, instance_id: id, result: 'ok', duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: true,
              instance_id: id,
              x,
              y,
              button,
              double_click: doubleClick,
              display_width: actual.displayWidth,
              display_height: actual.displayHeight,
              invalidated_drafts: invalidatedDrafts,
            });
          } catch (e: any) {
            if (e instanceof DisplaySizeMismatchError) {
              auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'display_size_mismatch', duration_ms: state.now() - t0 });
              return jsonTextResult({
                ok: false,
                error: 'display_size_mismatch',
                instance_id: id,
                expected_display_width: e.expectedWidth,
                expected_display_height: e.expectedHeight,
                actual_display_width: e.actualWidth,
                actual_display_height: e.actualHeight,
              });
            }
            throw e;
          }
        }

        case 'woc_scroll': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const x = Math.round(requireFiniteNumber(args, 'x'));
          const y = Math.round(requireFiniteNumber(args, 'y'));
          const displayWidth = requirePositiveInt(args, 'display_width');
          const displayHeight = requirePositiveInt(args, 'display_height');
          const dirRaw = args.direction;
          if (dirRaw !== 'up' && dirRaw !== 'down' && dirRaw !== 'left' && dirRaw !== 'right') {
            throw new Error('invalid_argument: direction must be up, down, left, or right');
          }
          const direction: ScrollDirection = dirRaw;
          let clicks = 3;
          if (args.clicks !== undefined) {
            if (typeof args.clicks !== 'number' || !Number.isInteger(args.clicks) || args.clicks < 1 || args.clicks > 20) {
              throw new Error('invalid_argument: clicks must be an integer between 1 and 20');
            }
            clicks = args.clicks;
          }

          const inst = deps.findInstance(id);
          if (!inst) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'instance_not_found', duration_ms: state.now() - t0 });
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }

          if (x < 0 || x >= displayWidth || y < 0 || y >= displayHeight) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'coordinates_out_of_bounds', duration_ms: state.now() - t0 });
            return jsonTextResult(
              {
                ok: false,
                error: 'coordinates_out_of_bounds',
                instance_id: id,
                x,
                y,
                display_width: displayWidth,
                display_height: displayHeight,
              },
              true,
            );
          }

          const guard = await checkWriteGuards(inst, false);
          if (!guard.ok) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: guard.error, duration_ms: state.now() - t0 });
            return jsonTextResult(guard.payload);
          }

          const liveWin = await deps.wechatWindowInfo(inst);
          if (liveWin.displayWidth !== displayWidth || liveWin.displayHeight !== displayHeight) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'display_size_mismatch', duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: false,
              error: 'display_size_mismatch',
              instance_id: id,
              expected_display_width: displayWidth,
              expected_display_height: displayHeight,
              actual_display_width: liveWin.displayWidth,
              actual_display_height: liveWin.displayHeight,
            });
          }

          if (!deps.scrollInInstance) throw new Error('scrollInInstance handler not configured');
          try {
            const actual = await deps.scrollInInstance(inst, {
              x,
              y,
              displayWidth,
              displayHeight,
              direction,
              clicks,
            });
            const invalidatedDrafts = state.draftStore.invalidateInstance(inst.id);
            auditWrite({ tool: toolName, instance_id: id, result: 'ok', duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: true,
              instance_id: id,
              x,
              y,
              direction,
              clicks,
              display_width: actual.displayWidth,
              display_height: actual.displayHeight,
              invalidated_drafts: invalidatedDrafts,
            });
          } catch (e: any) {
            if (e instanceof DisplaySizeMismatchError) {
              auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'display_size_mismatch', duration_ms: state.now() - t0 });
              return jsonTextResult({
                ok: false,
                error: 'display_size_mismatch',
                instance_id: id,
                expected_display_width: e.expectedWidth,
                expected_display_height: e.expectedHeight,
                actual_display_width: e.actualWidth,
                actual_display_height: e.actualHeight,
              });
            }
            throw e;
          }
        }

        case 'woc_draft_reply': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const text = args.text;
          if (typeof text !== 'string' || text.length === 0 || text.length > MAX_DRAFT_TEXT_CHARS) {
            throw new Error(`invalid_argument: text must be a non-empty string (<= ${MAX_DRAFT_TEXT_CHARS} chars)`);
          }
          const textLength = text.length;
          const shotOpts = parseScreenshotArgs(args, false);

          const inst = deps.findInstance(id);
          if (!inst) {
            auditWrite({ tool: toolName, instance_id: id, text_length: textLength, result: 'rejected', error: 'instance_not_found', duration_ms: state.now() - t0 });
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }

          const guard = await checkWriteGuards(inst, false);
          if (!guard.ok) {
            auditWrite({ tool: toolName, instance_id: id, text_length: textLength, result: 'rejected', error: guard.error, duration_ms: state.now() - t0 });
            return jsonTextResult(guard.payload);
          }

          if (!deps.typeInInstance || !deps.captureSessionFingerprint) {
            throw new Error('draft reply handlers not configured');
          }

          // Focus active WeChat chat input, clear any residual text, and paste ONLY — NEVER press Return.
          await deps.typeInInstance(inst, text, { focusChat: true, clearFirst: true, send: false });
          const fingerprint = await deps.captureSessionFingerprint(inst);
          if (fingerprint.headerInkPixels < MIN_HEADER_INK_PIXELS) {
            auditWrite({
              tool: toolName,
              instance_id: id,
              text_length: textLength,
              result: 'rejected',
              error: 'header_blank',
              duration_ms: state.now() - t0,
            });
            return jsonTextResult({
              ok: false,
              error: 'header_blank',
              instance_id: inst.id,
              header_ink_pixels: fingerprint.headerInkPixels,
              min_header_ink_pixels: MIN_HEADER_INK_PIXELS,
              header_region: fingerprint.headerRegion,
              input_may_have_residual_draft: true,
              discard_hint: 'Call woc_discard_draft to clear any residual text in the WeChat input box.',
              message:
                'WeChat chat header appears blank or obscured (insufficient title ink pixels); no draft_id issued.',
            });
          }

          const shot = await deps.captureInstanceScreenshot(inst, shotOpts);
          const draft = state.draftStore.create(inst.id, textLength, fingerprint);
          const ttlSec = Math.max(1, Math.round((draft.expiresAt - draft.createdAt) / 1000));

          auditWrite({ tool: toolName, instance_id: id, text_length: textLength, result: 'ok', duration_ms: state.now() - t0 });
          return {
            content: [
              {
                type: 'image' as const,
                data: shot.png.toString('base64'),
                mimeType: 'image/png',
              },
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  draft_id: draft.draftId,
                  expires_at: new Date(draft.expiresAt).toISOString(),
                  ttl_sec: ttlSec,
                  instance_id: inst.id,
                  text_length: textLength,
                  display_width: shot.displayWidth,
                  display_height: shot.displayHeight,
                  image_width: shot.imageWidth,
                  image_height: shot.imageHeight,
                  bytes: shot.bytes,
                  fingerprint_summary: {
                    digest: fingerprint.digest,
                    header_ink_pixels: fingerprint.headerInkPixels,
                    header_region: fingerprint.headerRegion,
                    editor_region: fingerprint.editorRegion,
                  },
                  wechat_window: shot.wechatWindow,
                }),
              },
            ],
          };
        }

        case 'woc_confirm_send': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const draftId = args.draft_id;
          if (typeof draftId !== 'string' || !draftId.trim() || draftId.length > 128) {
            throw new Error('invalid_argument: draft_id must be a non-empty string');
          }

          const residualMeta = {
            input_may_have_residual_draft: true,
            discard_hint: 'Call woc_discard_draft to clear any residual text in the WeChat input box.',
          };

          // Atomically consume draft_id immediately so it can NEVER be replayed/retried.
          const draft = state.draftStore.consume(draftId.trim());
          if (!draft) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'draft_not_found', duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: false,
              error: 'draft_not_found',
              instance_id: id,
              ...residualMeta,
              message: 'Draft not found or already consumed. Create a new draft with woc_draft_reply or clear the input box with woc_discard_draft.',
            });
          }

          if (state.now() > draft.expiresAt) {
            auditWrite({ tool: toolName, instance_id: id, text_length: draft.textLength, result: 'rejected', error: 'draft_expired', duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: false,
              error: 'draft_expired',
              instance_id: id,
              ...residualMeta,
              message: 'Draft expired before confirmation. Create a new draft with woc_draft_reply or clear the input box with woc_discard_draft.',
            });
          }

          if (draft.instanceId !== id) {
            auditWrite({ tool: toolName, instance_id: id, text_length: draft.textLength, result: 'rejected', error: 'draft_instance_mismatch', duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: false,
              error: 'draft_instance_mismatch',
              instance_id: id,
              ...residualMeta,
              message: 'draft_id does not belong to this instance_id; draft has been consumed.',
            });
          }

          const inst = deps.findInstance(id);
          if (!inst) {
            auditWrite({ tool: toolName, instance_id: id, text_length: draft.textLength, result: 'rejected', error: 'instance_not_found', duration_ms: state.now() - t0 });
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id, ...residualMeta }, true);
          }

          const guard = await checkWriteGuards(inst, true);
          if (!guard.ok) {
            auditWrite({ tool: toolName, instance_id: id, text_length: draft.textLength, result: 'rejected', error: guard.error, duration_ms: state.now() - t0 });
            return jsonTextResult({ ...guard.payload, ...residualMeta });
          }

          if (!deps.captureSessionFingerprint || !deps.keyInInstance) {
            throw new Error('confirm send handlers not configured');
          }

          const liveFp = await deps.captureSessionFingerprint(inst);
          const cmp = compareSessionFingerprints(draft.fingerprint, liveFp, {
            editorMaxDiffPixels: deps.editorMaxDiffPixels ?? null,
          });
          const formatHeaderCheck = (m: HeaderCheckMetrics) => ({
            match: m.match,
            diff_pixels: m.diffPixels,
            total_pixels: m.totalPixels,
            mean_abs_diff: m.meanAbsDiff,
          });
          const formatEditorCheck = (m: EditorCheckMetrics) => ({
            enforced: m.enforced,
            match: m.match,
            diff_pixels: m.diffPixels,
            changed_pixels_20: m.changedPixels20,
            total_pixels: m.totalPixels,
            mean_abs_diff: m.meanAbsDiff,
            changed_pixel_ratio: m.changedPixelRatio,
            max_diff_pixels: m.maxDiffPixels,
          });
          if (!cmp.match) {
            const errCode = cmp.reason ?? 'session_fingerprint_mismatch';
            auditWrite({ tool: toolName, instance_id: id, text_length: draft.textLength, result: 'rejected', error: errCode, duration_ms: state.now() - t0 });
            return jsonTextResult({
              ok: false,
              error: errCode,
              instance_id: id,
              detail: cmp.detail,
              header_check: formatHeaderCheck(cmp.headerCheck),
              editor_check: formatEditorCheck(cmp.editorCheck),
              ...residualMeta,
              message: 'Active chat window, header, or editor changed since draft; send aborted and draft consumed.',
            });
          }

          // Send ONE Return key — NEVER re-paste and NEVER auto-retry on failure.
          try {
            await deps.keyInInstance(inst, 'Return');
          } catch (e: any) {
            const msg = e instanceof Error ? e.message : String(e);
            auditWrite({ tool: toolName, instance_id: id, text_length: draft.textLength, result: 'error', error: 'send_uncertain_no_retry', duration_ms: state.now() - t0 });
            return jsonTextResult(
              {
                ok: false,
                error: 'send_uncertain_no_retry',
                instance_id: id,
                detail: msg,
                ...residualMeta,
                message: 'Return key dispatch failed or timed out; draft was consumed and will NOT be auto-retried. Inspect a screenshot before retrying manually.',
              },
              true,
            );
          }

          auditWrite({ tool: toolName, instance_id: id, text_length: draft.textLength, result: 'ok', duration_ms: state.now() - t0 });
          return jsonTextResult({
            ok: true,
            sent: true,
            instance_id: id,
            text_length: draft.textLength,
            header_check: formatHeaderCheck(cmp.headerCheck),
            editor_check: formatEditorCheck(cmp.editorCheck),
          });
        }

        case 'woc_discard_draft': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const inst = deps.findInstance(id);
          if (!inst) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: 'instance_not_found', duration_ms: state.now() - t0 });
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }

          const guard = await checkWriteGuards(inst, false);
          if (!guard.ok) {
            auditWrite({ tool: toolName, instance_id: id, result: 'rejected', error: guard.error, duration_ms: state.now() - t0 });
            return jsonTextResult(guard.payload);
          }

          if (!deps.clearInputInInstance) {
            throw new Error('clearInputInInstance handler not configured');
          }

          const invalidatedDrafts = state.draftStore.invalidateInstance(inst.id);
          await deps.clearInputInInstance(inst);
          auditWrite({ tool: toolName, instance_id: id, result: 'ok', duration_ms: state.now() - t0 });
          return jsonTextResult({
            ok: true,
            instance_id: id,
            invalidated_drafts: invalidatedDrafts,
            input_cleared: true,
          });
        }

        default:
          log(`[mcp] tool=${toolName} instanceId=${logInstanceId} durationMs=${state.now() - t0} ok=false reason=unknown_tool`);
          return jsonTextResult({ ok: false, error: 'unknown_tool', tool: toolName }, true);
      }
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isWriteTool) {
        auditWrite({ tool: toolName, instance_id: logInstanceId, result: 'error', error: msg, duration_ms: state.now() - t0 });
      } else {
        log(`[mcp] tool=${toolName} instanceId=${logInstanceId} durationMs=${state.now() - t0} ok=false error=${msg}`);
      }
      return jsonTextResult({ ok: false, error: msg }, true);
    }
  });

  return server;
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): { enabled: boolean; allowWrite: boolean } {
  const token = (deps.authToken ?? process.env.MCP_AUTH_TOKEN ?? '').trim();
  const allowWrite = deps.allowWrite !== undefined ? deps.allowWrite === true : process.env.MCP_ALLOW_WRITE === '1';
  const log = deps.log ?? ((line: string) => console.log(line));

  if (!token) {
    log('[mcp] disabled (MCP_AUTH_TOKEN not set)');
    return { enabled: false, allowWrite: false };
  }

  const now = deps.now ?? (() => Date.now());
  const state: McpRuntimeState = {
    allowWrite,
    draftStore: new DraftStore({ ttlMs: deps.draftTtlMs, now }),
    rateLimiter: new WriteRateLimiter(deps.rateLimits, now),
    now,
  };

  // Reject any unexpected subpath under /mcp/* explicitly so it never falls back to SPA HTML.
  app.all('/mcp/*', async (_req, reply) => reply.code(404).send({ error: 'not found' }));

  app.all('/mcp', { bodyLimit: MCP_BODY_LIMIT_BYTES }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store, max-age=0');

    if (req.method !== 'POST') {
      reply.header('Allow', 'POST');
      return reply.code(405).send({ error: 'Method Not Allowed' });
    }

    const originHeader = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (!isOriginAllowed(originHeader, deps.allowedHosts)) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }

    const authHeader = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    if (!verifyBearerToken(authHeader, token)) {
      reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return reply.code(415).send({ error: 'Content-Type must be application/json' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return reply.code(400).send({ error: 'Invalid JSON-RPC request body' });
    }

    reply.hijack();
    reply.raw.setHeader('Cache-Control', 'no-store, max-age=0');

    const server = createMcpServer(deps, state);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    };
    reply.raw.on('close', cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e: any) {
      log(`[mcp] transport error: ${e?.message || e}`);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    } finally {
      cleanup();
    }
  });

  log(`[mcp] Streamable HTTP endpoint enabled at POST /mcp (allowWrite=${allowWrite})`);
  return { enabled: true, allowWrite };
}
