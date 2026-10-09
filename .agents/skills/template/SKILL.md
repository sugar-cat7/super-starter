# Template maintenance

Apply to blueprints, initialization, app addition or shared tools. Read [AGENTS.md](../../../AGENTS.md), [template procedure](../../../docs/template.md), generator tests and [quality rules](../../../docs/quality.md).

Edit canonical blueprints under `tools/generators/templates`; regenerate the reference with `pnpm template:sync`. Do not maintain a second handwritten sample copy. Consult current tool documentation, record adoption reasoning and verify the smallest combination first. Run safety regression tests, `pnpm template:verify`, then `pnpm gate:full`. Preserve user edits and licenses; review migrations instead of overwriting downstream business code. Finish with all affected presets/native OS checks and evidence.
