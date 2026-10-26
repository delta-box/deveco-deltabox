# Deltabox plugin provenance

The adapter in this directory is vendored from
[delta-box/deveco-deltabox](https://github.com/delta-box/deveco-deltabox/tree/e7a3e09a05ae54a45962f4bf672f2dcaef83982c),
commit `e7a3e09a05ae54a45962f4bf672f2dcaef83982c`, under Apache-2.0 (see LICENSE).

Local adaptations: host-style imports and formatting, built-in registration,
native/stdio/CLI runtime resolution from the DevEco Code distribution, and
explicit configuration-layer merging with the host's Zod version. The review
lifecycle and tools also integrate the host's existing LSP and formatter
services through Lite's mounted view using direct internal imports rather than
additional host-injected plugin capabilities. Keep this source
revision explicit when syncing future changes.

The native runtime is deltabox-lite 0.1.4, also Apache-2.0. Release builds copy
its target-specific executable, addon and license into vendor/deltabox.
