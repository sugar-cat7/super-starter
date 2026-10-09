# Native prerequisites and verification

The selected Desktop package owns `src-tauri/rust-toolchain.toml`, Cargo.lock, Tauri config/capabilities and its SPA. Web/API-only projects install no Rust or Tauri package. Install rustup using its [official installation](https://rustup.rs/) for your existing development environment; setup activates the package's pinned toolchain. No root Rust pin is duplicated in mise.

Follow [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): macOS Xcode command-line tools; Windows MSVC C++ tools and WebView2; Linux GTK3, WebKitGTK 4.1, libayatana-appindicator, librsvg, patchelf and build tools. On an environment you cannot provision, doctor reports the missing libraries. CI's standard hosted Linux image installs those packages and uses Xvfb. A Linux result does not certify Windows/macOS.

The package scripts `test:rust`, `test:native`, `test:release`, `build` and optional `build:bundle` operate independently. `pnpm build` builds each selected package; Desktop's ordinary build is unsigned and has no bundle/publication step. Signed installers, certificates, notarization and distribution require separate authorized work.

Native E2E follows the [current Tauri recommendation](https://v2.tauri.app/develop/tests/webdriver/) and [embedded WebdriverIO setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup). Cargo feature `e2e`, test config/capabilities, renderer mode and target directory are separate. It starts the real app on Linux/macOS/Windows and invokes real Rust CRUD, cancel/error/export and denied unknown commands. A test-only process environment chooses an export fixture; production IPC accepts no path. Normal release rebuilds without the feature/import/global API, checks dependency/capability/frontend isolation, starts the native window and verifies that setting the test driver port cannot enable a listener.

User-selected native dialog interaction is distinct from the controlled E2E fixture. Remote connections, public distribution and signing have not been performed by setup or CI.
