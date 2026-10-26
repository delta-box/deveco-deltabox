// SPDX-License-Identifier: Apache-2.0
// DevEco distribution adapter; see NOTICE.md for provenance.
import { createRequire } from "node:module"
import path from "node:path"
import type { DeltaboxNativeBinding } from "deltabox-lite"

declare const DEVECO_VERSION: string

const require = createRequire(import.meta.url)

export function loadDeltabox() {
  // Source runs use the optional npm dependency. Compiled releases resolve only
  // their own sidecars, so a missing bundle cannot pick up an ambient runtime.
  if (typeof DEVECO_VERSION !== "string") {
    return require("deltabox-lite") as typeof import("deltabox-lite")
  }
  const root = path.resolve(path.dirname(process.execPath), "../vendor/deltabox")
  return {
    binaryPath: () => path.join(root, process.platform === "win32" ? "deltabox.exe" : "deltabox"),
    loadNative: () => require(path.join(root, "deltabox.node")) as DeltaboxNativeBinding,
  }
}
