// SPDX-License-Identifier: Apache-2.0
// Adapted from delta-box/deveco-deltabox; see NOTICE.md for provenance and changes.
import { randomUUID } from "node:crypto"
import type { ToolContext } from "@opencode-ai/plugin"
import type { ReviewMode } from "./config"
import type { Client, Diff } from "./client"

export function summary(diff: Diff): string {
  return (
    diff.changes
      .map((c) => `${c.path} (${c.kind}${c.is_binary ? ", binary" : ` +${c.added_lines} -${c.removed_lines}`})`)
      .join("\n") || "No pending changes."
  )
}

export function renderDiff(diff: Diff): string {
  return (
    diff.changes
      .map((c) =>
        [
          `${c.kind}: ${c.path}${c.is_binary ? " (binary)" : ""}`,
          c.text_diff ?? `size: ${c.old_size ?? 0} -> ${c.new_size ?? 0}`,
        ].join("\n"),
      )
      .join("\n\n") || "No pending changes."
  )
}

/** Review boundaries report changes; only user commands accept or roll them back. */
export async function pendingReview(client: Pick<Client, "active" | "review" | "commit">): Promise<string> {
  if (!(await client.active())) return "No active review."
  const diff = await client.review()
  if (!diff.pending_changes) {
    await client.commit()
    return "No pending changes."
  }
  return `${diff.pending_changes} pending change(s):\n${summary(diff)}\nUse /sandbox-diff or /sandbox-review to inspect, /sandbox-commit to accept, /sandbox-abort to roll back or /sandbox-skip to keep pending.`
}

type Reply = "once" | "always" | "reject"
type Pending = { sessionID: string; requestID?: string; reply?: Reply }

/** Respect the host's permission decision, including its configured auto mode.
 * A rejection event is distinguished from cancellation or an unavailable UI. */
export class ReviewGate {
  private pending = new Map<string, Pending>()

  event(event: { type: string; properties: any }): void {
    const p = event.properties
    if (event.type === "permission.asked" && p.permission === "deltabox_review") {
      const pending = this.pending.get(p.metadata?.deltaboxReview)
      if (pending && pending.sessionID === p.sessionID) pending.requestID = p.id
    }
    if (event.type === "permission.replied") {
      for (const pending of this.pending.values()) {
        if (pending.sessionID === p.sessionID && pending.requestID === p.requestID) pending.reply = p.reply
      }
    }
  }

  async review(
    client: Pick<Client, "active" | "review" | "commit" | "abort">,
    ctx: ToolContext,
    mode?: ReviewMode,
  ): Promise<string> {
    const scope = await client.active()
    if (!scope) return "No active review."
    const diff = await client.review()
    if (!diff.pending_changes) {
      await client.commit()
      return "No pending changes."
    }
    if (ctx.abort.aborted) return "Changes remain pending after cancellation."
    const token = randomUUID()
    const pending: Pending = { sessionID: ctx.sessionID }
    this.pending.set(token, pending)
    let error: unknown
    try {
      try {
        await ctx.ask({
          permission: "deltabox_review",
          patterns: [
            `Keep all ${diff.pending_changes} pending file change(s)? Allow keeps them; Reject rolls them back.\n${summary(diff)}`,
          ],
          always: [],
          metadata: {
            deltaboxReview: token,
            reviewMode: mode ?? scope.kind,
            pendingChanges: diff.pending_changes,
            changes: diff.changes.map(({ path, kind, added_lines, removed_lines, is_binary }) => ({
              path,
              kind,
              added_lines,
              removed_lines,
              is_binary,
            })),
          },
        })
      } catch (cause) {
        error = cause
      }
      // The host publishes permission.replied before resolving its permission promise.
      if (ctx.abort.aborted) return "Changes remain pending after cancellation."
      if (pending.reply === "reject") {
        const result = await client.abort()
        return `User rejected the review. Rolled back ${result.restored} change(s).`
      }
      if (error) throw error
      const result = await client.commit()
      return `Accepted ${result.applied} change(s).`
    } finally {
      this.pending.delete(token)
    }
  }
}
