# Lighthouse: all categories at 100

Every Web HTML page must score **100 in every Lighthouse category**, on both official mobile and desktop profiles, in all three independent runs. No averaging, best-run selection, threshold exception, audit exclusion or disabled throttling is allowed. Lighthouse 13.5.0 reports Performance, Accessibility, Best Practices, SEO and Agentic Browsing. The latter displays a fraction in the official report; its normalized score must also equal 1. An error, missing category, missing report, unsuccessful/non-HTML page or timeout fails the command.

Use the selected project-local tools and provision Chromium with the owning package's Playwright CLI:

```console
pnpm env:setup
pnpm env:doctor
pnpm --filter <scope>/<web-directory> exec playwright install chromium
pnpm test:lighthouse
pnpm --filter <scope>/<web-directory> test:lighthouse
pnpm gate:pre-pr -- --base <base-sha>
pnpm gate:full
```

Linux also needs the official Playwright OS libraries; CI installs them with `playwright install --with-deps chromium`. A missing browser is diagnosed with the owning command. The runner uses this installed Chromium, never an implicit global browser. It builds the Web package and its selected Worker dependencies, prepares disposable local Binding state, then starts the production build locally. Package preview adapters use the config SDK to convert the offline build output into disposable Wrangler configuration and run its local HTTP server. `cloudflare.config.ts` remains the sole authored Worker/Binding configuration. This transport preserves actual compressed responses; Vite's in-process preview bridge decompresses them before HTTP delivery. No remote resources, credentials or deployment are required. API-only and Desktop-only configurations report Lighthouse `not_required`; their actual Worker/native checks remain mandatory. A Web manifest missing its audit script fails even the direct root command.

The Web production build uses an explicit global CSS link in the root route head, separately cacheable React/ReactDOM chunks, and TanStack's supported custom client entry. It yields one rendering opportunity before asynchronously loading the unchanged SDK hydration flow; hidden tabs start immediately. The shared input remains read-only until hydration and its initial adapter load complete. These are ordinary application settings used in development and deployable output. Exercise styled SSR, readiness, safe keyboard input and client navigation as well as scores; no audit-only loading path is allowed.

Static page URLs are derived from TanStack's generated `FileRoutesByFullPath`, so adding a page automatically adds its audits. Dynamic routes require local fixture URLs in the owning `package.json`, for example:

```json
{
  "starter": {
    "runtime": "worker",
    "lighthouse": {
      "routes": { "/notes/$id": "/notes/local-fixture" }
    }
  }
}
```

Fixtures must cover their actual routes; foreign origins, fragments and missing routes fail. The manifest is parsed as TypeScript, including quoted keys containing braces. Named parameters and splats are supported; richer braced/escaped route syntax fails explicitly until its matcher is verified against the adopted router SDK, so it cannot silently omit pages. Prepare local data through the application, rather than substituting a different page. Keep lifecycle, API, keyboard, axe and visual tests: a Lighthouse score does not replace behavioral tests or manual accessibility review.

`tools/quality/lighthouse.ts` owns execution through the official Lighthouse API and unmodified mobile/desktop configurations; `test-results.ts` checks complete reports and exact normalized scores of 1. Each run gets a fresh owned Chromium process/profile with the official CLI's browser flags, read from Lighthouse's installed Chrome launcher SDK; the pinned CLI's `DevToolsWebMCPSupport` feature flag is included so those audits retain their protocol support. Background browser services are suppressed while throttling and audits remain unchanged. Timeout or interruption closes that browser and the selected local preview processes and records failure. The existing check registry schedules the required Web check in affected/full and JavaScript CI gates. No separate Lighthouse CI service, configuration registry or Agent hook is added. Worker-only and native CI variants retain their distinct runtime scope; the JavaScript job verifies the Web audits.

Each run writes raw JSON and HTML under `artifacts/lighthouse/<web-directory>`, plus a summary containing routes, device profiles, all runs, versions, input SHA/content ID and failures. Existing CI artifact upload preserves these reports. Inspect the failed JSON audit/HTML report, fix the application or actual delivery path, rerun the owning check, then run the affected/final gate. Never update score evidence or visual baselines just to hide a failure. Local results describe that local build; deployed URLs require approved dev deployment and a separate real measurement.

Adoption uses the [13.5.0 release](https://github.com/GoogleChrome/lighthouse/releases/tag/v13.5.0), [CLI and configuration specification](https://github.com/GoogleChrome/lighthouse/tree/v13.5.0/docs), installed SDK/report types and a real production-build compatibility check on Node 24.21.0. Keep the exact catalog/lock version and the existing dependency update process; review new categories and profile changes when upgrading.
