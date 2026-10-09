# Worker and service development

Apply to Worker/API/Binding work. Read [AGENTS.md](../../../AGENTS.md), the owning `cloudflare.config.ts` and [Cloudflare guidance](../../../docs/cloudflare.md). Configuration is the sole binding/environment source; SDK output and generated types are derived. Verify current SDK signatures before changing it.

Add with `pnpm app:new -- --kind api --name <name>`. Run `pnpm env:setup`, package unit/runtime tests, then `pnpm gate:pre-pr`. Test real workerd, selected resources, malformed input, safe error/log output and remote deny-write defaults. Finish with consistent migration/typegen/build output and deployment preflight; credentials or remote approval are never implied.
