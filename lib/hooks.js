// Cross-module callbacks without import cycles: panel-api and login raise
// events, index decides what a refresh means.

export const hooks = {
  /** (realmId) => void — a login landed, the realm's whitelist may differ now. */
  onLoggedIn: null,
  /** (realmId) => void — the exposed site changed; routes must be re-committed. */
  onRealmChanged: null,
}
