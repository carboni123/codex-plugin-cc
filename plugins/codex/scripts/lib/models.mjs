// Model names the commands accept in place of a Codex model id.

// A family name stands for the newest model of that family Codex lists for this account, so a
// new release is used once Codex offers it, not once the plugin is updated. The id here is used
// when the list cannot be read or has no model of the family.
const MODEL_FAMILIES = new Map([
  ["sol", "gpt-6.2-sol"],
  ["astra", "gpt-6.2-astra"]
]);
const FIXED_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);

export const MODEL_FAMILY_NAMES = [...MODEL_FAMILIES.keys()];

// Only `gpt-<version>-<family>` belongs to the family: `gpt-7-sol-mini` is another model.
function familyVersion(id, family) {
  const match = /^gpt-(\d+(?:\.\d+)*)-(.+)$/.exec(String(id ?? ""));
  return match && match[2] === family ? match[1].split(".").map(Number) : null;
}

// 6.10 is newer than 6.2, and 6.1 is newer than 6.
function isNewerVersion(candidate, current) {
  for (let index = 0; index < Math.max(candidate.length, current.length); index += 1) {
    const difference = (candidate[index] ?? 0) - (current[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}

/**
 * @param {Array<{ id?: string, model?: string, hidden?: boolean }>} models entries of the app
 *   server's `model/list`
 * @param {string} family
 * @returns {string | null} the id to pass as `model`, or null when no listed model is in the family
 */
export function newestFamilyModel(models, family) {
  let newest = null;
  for (const entry of models ?? []) {
    const id = entry?.model ?? entry?.id;
    const version = entry?.hidden ? null : familyVersion(id, family);
    if (version && (!newest || isNewerVersion(version, newest.version))) {
      newest = { id, version };
    }
  }
  return newest?.id ?? null;
}

/**
 * @param {string | null | undefined} name what the user or a setting asked for
 * @param {() => Promise<Array<object>>} listModels reads Codex's model list; called only for a
 *   family name
 * @returns {Promise<{ model: string | null, alias: string | null, origin: string | null }>}
 *   `origin` says where a family name's model id came from
 */
export async function resolveModelName(name, listModels) {
  const requested = String(name ?? "").trim();
  if (!requested) {
    return { model: null, alias: null, origin: null };
  }
  const alias = requested.toLowerCase();
  if (FIXED_ALIASES.has(alias)) {
    return { model: FIXED_ALIASES.get(alias), alias, origin: null };
  }
  const builtIn = MODEL_FAMILIES.get(alias);
  if (!builtIn) {
    return { model: requested, alias: null, origin: null };
  }

  let reason;
  try {
    const newest = newestFamilyModel(await listModels(), alias);
    if (newest) {
      return { model: newest, alias, origin: `the newest ${alias} model Codex lists` };
    }
    reason = `Codex lists no ${alias} model`;
  } catch (error) {
    reason = `Codex's model list could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { model: builtIn, alias, origin: `the plugin's built-in id, because ${reason}` };
}
