/**
 * Argv construction helpers used by every gt tool to harden against
 * argv/flag-injection from user-controlled strings.
 *
 * Threat model: tool parameters (branch, message, onto, target, ...) end up
 * as argv tokens passed to `gt`. `gt`'s yargs parser will happily interpret
 * any token that starts with `-` as an option — including `--interactive`,
 * which silently overrides our earlier `--no-interactive` and re-enables
 * TTY prompts. It will also swallow the *next* argv token as the value of a
 * preceding option (e.g. `--message` `--interactive` => message is dropped,
 * --interactive becomes a flag).
 *
 * Two defenses:
 *
 *  1) For positional/ref values (branch names, refs, paths, PR numbers) we
 *     require that the value does not start with `-`. Git branch names
 *     cannot validly start with `-`; pathspecs and PR numbers shouldn't for
 *     these tools either.
 *
 *  2) For option *values* we emit `--flag=value` as a single argv token
 *     instead of two tokens `--flag` `value`. yargs binds the value to the
 *     option literally regardless of leading `-`, so the value can never be
 *     re-parsed as a flag.
 */

export function assertSafeRef(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (value === "") {
    throw new Error(`${label} must not be empty.`);
  }
  if (value === "--") {
    throw new Error(`${label} must not be "--".`);
  }
  if (value.startsWith("-")) {
    throw new Error(
      `${label} must not start with "-" (got ${JSON.stringify(value)}). ` +
        `Refused to prevent flag injection into the gt CLI.`,
    );
  }
  return value;
}

/**
 * Build a single argv token `--flag=value`. Use for option values supplied
 * by the caller. The `=` form binds the value to the flag literally so a
 * value like `--interactive` is preserved as data instead of being parsed
 * as the next option.
 */
export function flagEq(flag: string, value: string | number): string {
  if (!flag.startsWith("--")) {
    throw new Error(`flagEq: flag must start with "--", got ${flag}`);
  }
  if (flag.includes("=")) {
    throw new Error(`flagEq: flag must not already contain "=" (got ${flag}).`);
  }
  return `${flag}=${value}`;
}

/**
 * POSIX shell single-quote a value so the rendered command line is safe to
 * copy-paste into a shell. argv execution itself never goes through a shell
 * (we use spawn with an argv array), but rendered commands appear in tool
 * output and labels; a user pasting them must not trigger command
 * substitution, word splitting, or metacharacter interpretation.
 *
 * Rule: wrap in single quotes, and replace each embedded single quote with
 * the POSIX-portable sequence '\''. Tokens consisting solely of
 * [A-Za-z0-9_=:,.@/+-] are left unquoted for readability.
 */
export function shellQuote(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_=:,.@\/+\-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Join argv tokens into a shell-safe single line. */
export function shellJoin(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}
