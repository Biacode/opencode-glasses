// Local-directory entrypoint for OpenCode 2 plugin discovery.
// npm/git package installs resolve via package.json "main" -> src/index.ts;
// this shim makes `plugins: ["/path/to/opencode-glasses"]` work too.
export { default } from "../../src/index.ts"
