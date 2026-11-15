// BN3 (依頼-250, docs/naming.md 3.3): the internal identifiers of BantoDesk in one place. The former name
// (agent-terminal) is kept here only to READ what older versions wrote (compat); nothing new is written there.
// The e2e mark --agent-terminal-e2e is not here: it is a security mark and stays (src/main/e2e.js).
// No Electron imports (testable from plain Node).
const NAME = 'bantodesk';
const LEGACY = 'agent-terminal'; // compat (read only)

module.exports = {
  NAME,
  LEGACY,
  // <folder>/.bantodesk/ (outbox, edit metadata). The legacy .agent-terminal/ is still read for a while.
  META_DIR: `.${NAME}`,
  LEGACY_META_DIR: `.${LEGACY}`,
  // the app's MCP server (tools mcp__bantodesk__*)
  MCP_NAME: NAME,
  // <tmp>/bantodesk-temp (temp / edit sessions), <tmp>/bantodesk-paste (pasted images)
  TEMP_DIR: `${NAME}-temp`,
  LEGACY_TEMP_DIR: `${LEGACY}-temp`,
  PASTE_DIR: `${NAME}-paste`,
  // userData folder name (app.getName(), package.json name) -> the former name whose data is copied once
  USERDATA_LEGACY: { [NAME]: LEGACY, [`${NAME}-dev`]: `${LEGACY}-dev` },
};
