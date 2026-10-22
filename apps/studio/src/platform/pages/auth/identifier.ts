// Sign-in identifiers and usernames, checked in the browser before anything is sent. The username rules restate
// private.is_valid_username (supabase/migrations …_foundation.sql), as core/memory/rules.ts does for the backends;
// here they also explain what is wrong, so the forms can say it next to the field. Pure: unit-tested in node.

import { RESERVED_USERNAMES } from "../../core/memory/rules";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_CHARACTERS = /^[a-z0-9._-]+$/;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

export type Identifier =
  | { kind: "email"; value: string }
  | { kind: "username"; value: string }
  | { kind: "invalid"; problem: string };

export function isEmailAddress(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** What the database stores for a username: trimmed, lower case. */
export function normalizeUsernameInput(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Why `value` cannot be a username (null when it can). Lower case is applied first, as the database does; an empty
 * value is not a problem here (the field is optional): callers decide whether one is needed.
 */
export function usernameProblem(value: string): string | null {
  const name = normalizeUsernameInput(value);
  if (name === "") return null;
  if (!USERNAME_CHARACTERS.test(name)) return "Use only letters, numbers, dots, hyphens and underscores.";
  if (name.length < USERNAME_MIN_LENGTH) return `Use at least ${USERNAME_MIN_LENGTH} characters.`;
  if (name.length > USERNAME_MAX_LENGTH) return `Use at most ${USERNAME_MAX_LENGTH} characters.`;
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return "Start and end with a letter or number.";
  if (/[._-]{2}/.test(name)) return "Don’t put dots, hyphens or underscores next to each other.";
  if (RESERVED_USERNAMES.has(name)) return "That username is reserved. Choose another one.";
  return null;
}

/**
 * Sorts what someone typed into "Email or Username": anything with an "@" is an email address (lower-cased, as Auth
 * stores it); anything else is a username when usernames are enabled. Reserved names still classify as usernames:
 * the server answers them like any wrong sign-in, so nothing here reveals which names exist.
 */
export function classifyIdentifier(input: string, options: { usernames: boolean }): Identifier {
  const value = input.trim();
  if (value === "") {
    return { kind: "invalid", problem: options.usernames ? "Enter your email address or username." : "Enter your email address." };
  }
  if (value.includes("@")) {
    return isEmailAddress(value) ? { kind: "email", value: value.toLowerCase() } : { kind: "invalid", problem: "Enter a valid email address." };
  }
  if (!options.usernames) return { kind: "invalid", problem: "Enter a valid email address." };
  const name = normalizeUsernameInput(value);
  const problem = usernameProblem(name);
  if (problem !== null && problem !== "That username is reserved. Choose another one.") {
    return { kind: "invalid", problem: "Enter a valid email address or username." };
  }
  return { kind: "username", value: name };
}
