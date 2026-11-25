import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { isAllowedHost } from './host-guard.js';
import {
  publicInstance,
  type Instance,
} from './store.js';
import type {
  RuntimeState,
  ScreenshotCrop,
  ScreenshotOptions,
  ScreenshotResult,
  TransferFile,
  WechatStatus,
  WechatWindowInfo,
} from './docker.js';
import { DIAG_RANGES, filterSince, rangeToMs } from './logs.js';

const MCP_BODY_LIMIT_BYTES = 256 * 1024; // 256 KiB JSON-RPC payload cap
const DEFAULT_LOG_TAIL = 100;
const MAX_LOG_TAIL = 500;
const MAX_LOG_BYTES = 64 * 1024; // 64 KiB cap on returned log text
const DEFAULT_SCREENSHOT_MAX_WIDTH = 1280;
const MIN_SCREENSHOT_MAX_WIDTH = 320;
const MAX_SCREENSHOT_MAX_WIDTH = 2560;

export interface ControlLockInfo {
  active: boolean;
  holder: string | null;
  ageMs: number | null;
}

export interface McpDeps {
  authToken?: string;
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
  effectiveLimits: (inst: Instance) => { soft: number; hard: number };
  activeVncViewerCount: (id: string) => number;
  getControlLock: (id: string) => ControlLockInfo;
  hasActiveSession: (id: string) => boolean;
  log?: (line: string) => void;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
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

function parseScreenshotArgs(args: Record<string, unknown>): ScreenshotOptions {
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
  if (args.crop !== undefined) {
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

function createMcpServer(deps: McpDeps): Server {
  const log = deps.log ?? ((line: string) => console.log(line));
  const server = new Server(
    {
      name: 'woc-panel-mcp',
      version: deps.panelVersion || 'dev',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Read-only MCP server for WechatOnCloud (WOC). Never assumes stopped instances can be started; check runtime state first.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawArgs = request.params.arguments;
    const args: Record<string, unknown> =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const t0 = Date.now();
    let logInstanceId = '-';

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
          log(`[mcp] tool=${toolName} instanceId=- durationMs=${Date.now() - t0} ok=true`);
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
          log(`[mcp] tool=${toolName} instanceId=- count=${out.length} durationMs=${Date.now() - t0} ok=true`);
          return jsonTextResult({ ok: true, instances: out });
        }

        case 'woc_instance_status': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const inst = deps.findInstance(id);
          if (!inst) {
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${Date.now() - t0} ok=false reason=not_found`);
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
              message: 'Instance is not running; read-only MCP does not start stopped containers.',
            };
            log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} durationMs=${Date.now() - t0} ok=true`);
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
          log(`[mcp] tool=${toolName} instanceId=${id} runtime=running durationMs=${Date.now() - t0} ok=true`);
          return jsonTextResult(payload);
        }

        case 'woc_get_logs': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const inst = deps.findInstance(id);
          if (!inst) {
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${Date.now() - t0} ok=false reason=not_found`);
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
            const since = Date.now() - rangeToMs(range);
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
          log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} tail=${tail} durationMs=${Date.now() - t0} ok=true`);
          return jsonTextResult(payload);
        }

        case 'woc_list_files': {
          const id = requireInstanceId(args);
          logInstanceId = id;
          const inst = deps.findInstance(id);
          if (!inst) {
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${Date.now() - t0} ok=false reason=not_found`);
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }
          const runtime = await deps.instanceRuntime(inst);
          if (runtime !== 'running') {
            log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} durationMs=${Date.now() - t0} ok=false reason=instance_stopped`);
            return jsonTextResult({
              ok: false,
              error: 'instance_stopped',
              instance_id: inst.id,
              runtime,
              message: 'Instance is not running; cannot list ~/Desktop files without starting the container.',
            });
          }
          const files = await deps.listInstanceFiles(inst);
          log(`[mcp] tool=${toolName} instanceId=${id} files=${files.length} durationMs=${Date.now() - t0} ok=true`);
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
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${Date.now() - t0} ok=false reason=not_found`);
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }
          const runtime = await deps.instanceRuntime(inst);
          if (runtime !== 'running') {
            log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} durationMs=${Date.now() - t0} ok=false reason=instance_stopped`);
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
            `[mcp] tool=${toolName} instanceId=${id} display=${info.displayWidth}x${info.displayHeight} hasWechat=${Boolean(info.wechatWindow)} durationMs=${Date.now() - t0} ok=true`,
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
            log(`[mcp] tool=${toolName} instanceId=${id} durationMs=${Date.now() - t0} ok=false reason=not_found`);
            return jsonTextResult({ ok: false, error: 'instance_not_found', instance_id: id }, true);
          }
          const runtime = await deps.instanceRuntime(inst);
          if (runtime !== 'running') {
            log(`[mcp] tool=${toolName} instanceId=${id} runtime=${runtime} durationMs=${Date.now() - t0} ok=false reason=instance_stopped`);
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

        default:
          log(`[mcp] tool=${toolName} instanceId=${logInstanceId} durationMs=${Date.now() - t0} ok=false reason=unknown_tool`);
          return jsonTextResult({ ok: false, error: 'unknown_tool', tool: toolName }, true);
      }
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[mcp] tool=${toolName} instanceId=${logInstanceId} durationMs=${Date.now() - t0} ok=false error=${msg}`);
      return jsonTextResult({ ok: false, error: msg }, true);
    }
  });

  return server;
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): { enabled: boolean } {
  const token = (deps.authToken ?? process.env.MCP_AUTH_TOKEN ?? '').trim();
  const log = deps.log ?? ((line: string) => console.log(line));

  if (!token) {
    log('[mcp] disabled (MCP_AUTH_TOKEN not set)');
    return { enabled: false };
  }

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

    const server = createMcpServer(deps);
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

  log('[mcp] read-only Streamable HTTP endpoint enabled at POST /mcp');
  return { enabled: true };
}
