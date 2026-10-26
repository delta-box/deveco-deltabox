import { Context, Effect, Exit, Layer, Scope, Schema } from "effect"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { AppProcess } from "@opencode-ai/core/process"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { makeRuntime } from "@/effect/run-service"
import { InstanceRef } from "@/effect/instance-ref"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import type { InstanceContext } from "@/project/instance-context"
import { query } from "@/tool/lsp"
import type { Parameters } from "@/tool/lsp"

export type LanguageRequest = Schema.Schema.Type<typeof Parameters>
export type LanguageView = { project: string; mountpoint: string }
export interface MountedLanguage {
  readonly enabled: boolean
  query(
    view: LanguageView,
    args: LanguageRequest,
  ): Promise<{
    title: string
    output: string
    metadata: { result: unknown[] }
  }>
  afterWrite(view: LanguageView, path: string): Promise<string>
  dispose(view: LanguageView): Promise<void>
}

export function createLanguage(instance: InstanceContext, config: ConfigV1.Info): MountedLanguage {
  // LSP clients canonicalize paths; WinFsp drive letters resolve to UNC shares.
  // Use the same root for requests, cache keys and returned diagnostic paths.
  const sessions = new Map<string, Promise<LanguageSession>>()
  const run = async <A, E>(
    view: LanguageView,
    effect: Effect.Effect<A, E, LSP.Service | Format.Service | FSUtil.Service>,
  ) => {
    const mountpoint = FSUtil.normalizePath(view.mountpoint)
    const existing = sessions.get(mountpoint)
    const session = existing ?? runtime.runPromise((service) => service.open(config))
    if (!existing) {
      sessions.set(mountpoint, session)
      void session.catch(() => sessions.delete(mountpoint))
    }
    const services = await session
    return runtime.runPromise(() =>
      effect.pipe(
        Effect.provide(services.context),
        Effect.provideService(InstanceRef, { ...instance, directory: mountpoint, worktree: mountpoint }),
      ),
    )
  }

  return {
    get enabled() {
      return Boolean(config.lsp || config.formatter)
    },
    async query(view, args) {
      const mountpoint = FSUtil.normalizePath(view.mountpoint)
      // Keep the caller's filename spelling: WinFsp canonicalization uppercases
      // extensions, which the unmodified native services match case-sensitively.
      const result = await run(view, query({ ...args, filePath: mapPath(args.filePath, view.project, mountpoint) }))
      const values = result.metadata.result.map((value) => mapResult(value, mountpoint, instance.directory))
      return {
        title: result.title,
        metadata: { result: values },
        output: values.length ? JSON.stringify(values, null, 2) : result.output,
      }
    },
    async afterWrite(view, file) {
      const mountpoint = FSUtil.normalizePath(view.mountpoint)
      const target = mapPath(file, view.project, mountpoint)
      await run(
        view,
        Format.Service.use((service) => service.file(target)),
      )
      return run(
        view,
        LSP.Service.use((service) =>
          Effect.gen(function* () {
            yield* service.touchFile(target, "document")
            const diagnostics = yield* service.diagnostics()
            return Object.entries(diagnostics)
              .filter(([file, issues]) => issues.length && FSUtil.contains(mountpoint, file))
              .sort(
                ([left], [right]) =>
                  Number(right === FSUtil.normalizePath(target)) - Number(left === FSUtil.normalizePath(target)),
              )
              .slice(0, 6)
              .map(([file, issues]) => LSP.Diagnostic.report(mapPath(file, mountpoint, instance.directory), issues))
              .filter(Boolean)
              .join("\n\n")
          }),
        ),
      )
    },
    async dispose(view) {
      const mountpoint = FSUtil.normalizePath(view.mountpoint)
      const session = sessions.get(mountpoint)
      if (!session) return
      const services = await session
      await runtime.runPromise(() => services.close)
      sessions.delete(mountpoint)
    },
  }
}

type LanguageSession = {
  context: Context.Context<LSP.Service | Format.Service | FSUtil.Service>
  close: Effect.Effect<void>
}

class Service extends Context.Service<
  Service,
  {
    open: (config: ConfigV1.Info) => Effect.Effect<LanguageSession>
  }
>()("@opencode/DeltaboxLanguage") {}

const runtime = makeRuntime(
  Service,
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const flags = yield* RuntimeFlags.Service
      const events = yield* EventV2Bridge.Service
      const process = yield* AppProcess.Service
      return Service.of({
        open: Effect.fn("DeltaboxLanguage.open")(function* (settings) {
          // Each mount owns a fresh layer scope. Closing it releases the native
          // InstanceState caches and LSP clients without adding disposal APIs to them.
          const scope = yield* Scope.make()
          const context = yield* Layer.buildWithMemoMap(
            Layer.mergeAll(LSP.layer, Format.layer, FSUtil.defaultLayer).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(Config.Service, { ...config, get: () => Effect.succeed(settings) }),
                  Layer.succeed(RuntimeFlags.Service, flags),
                  Layer.succeed(EventV2Bridge.Service, events),
                  Layer.succeed(AppProcess.Service, process),
                ),
              ),
            ),
            Layer.makeMemoMapUnsafe(),
            scope,
          ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
          return { context, close: Scope.close(scope, Exit.void) }
        }),
      })
    }),
  ).pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(AppProcess.defaultLayer),
  ),
)

function mapPath(file: string, from: string, to: string) {
  const absolute = path.resolve(from, file)
  if (!FSUtil.contains(from, absolute)) throw new Error(`Path is outside the language workspace: ${file}`)
  return path.resolve(to, path.relative(from, absolute))
}

function mapResult(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapResult(item, from, to))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapResult(item, from, to)]))
  if (typeof value !== "string") return value
  if (value.startsWith("file://")) {
    const file = fileURLToPath(value)
    return FSUtil.contains(from, file) ? pathToFileURL(mapPath(file, from, to)).href : value
  }
  if (path.isAbsolute(value) && FSUtil.contains(from, value)) return mapPath(value, from, to)
  return value
}
