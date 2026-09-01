/**
 * Key spellings shared by the two parallel secret lanes: `connector.` for API
 * connections and `mcp.` for MCP connections. Both lanes name environment
 * overrides the same way and keep the same style of durable deletion marker,
 * so only the lane prefix and its error wording differ.
 */

/**
 * Encode a validated id/header segment into a shell-safe, reversible spelling.
 * Escaping every non-alphanumeric character by its ASCII code matters here:
 * replacing both `-` and `_` with `_` would make two valid agent ids share one
 * environment override even though their stored settings are isolated.
 */
export function encodeEnvSegment(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, (character) =>
      '_' + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
    );
}

export interface SecretCleanupKeys {
  /** Deduplicate keys and confirm every one belongs to this Agent's lane. */
  validate(agentId: string, settingKeys: readonly string[]): string[];
  /** Read a stored marker back into its validated key list. */
  parse(agentId: string, raw: string): string[];
}

export function createSecretCleanupKeys(lane: {
  keyPrefix: string;
  invalidKeyMessage: string;
  invalidMarkerMessage: string;
}): SecretCleanupKeys {
  const validate = (agentId: string, settingKeys: readonly string[]): string[] => {
    const expectedPrefix = lane.keyPrefix + agentId + '.';
    const keys = [...new Set(settingKeys)];
    if (!keys.every((key) => key.startsWith(expectedPrefix))) {
      throw new Error(lane.invalidKeyMessage);
    }
    return keys;
  };
  return {
    validate,
    parse(agentId, raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(lane.invalidMarkerMessage);
      }
      if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === 'string')) {
        throw new Error(lane.invalidMarkerMessage);
      }
      return validate(agentId, parsed);
    },
  };
}
