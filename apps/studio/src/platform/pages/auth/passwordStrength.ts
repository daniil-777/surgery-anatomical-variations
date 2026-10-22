// A hint, not a rule: NIST-style passwords only need 8 characters (DESIGN.md §7, the server enforces exactly that), so
// the meter never asks for "an uppercase letter and a symbol". It does point out what makes a password easy to guess:
// very common choices, keyboard runs and repeats, and the person's own name or email. Pure: unit-tested in node.

export const MIN_PASSWORD_LENGTH = 8;

export type PasswordStrengthLevel = "empty" | "short" | "weak" | "fair" | "good" | "strong";

export interface PasswordStrength {
  level: PasswordStrengthLevel;
  /** 0 (empty or too short) … 4 (strong): filled segments of the meter. */
  score: 0 | 1 | 2 | 3 | 4;
  /** "Too Short", "Weak", "Fair", "Good", "Strong" ("" when empty). */
  label: string;
  /** One sentence on what would help. */
  hint: string;
  /** Long enough to be accepted by the server. */
  acceptable: boolean;
}

// the most common passwords of at least 8 characters in public breach corpora, lower-cased
const COMMON = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "12345678", "123456789", "1234567890",
  "11111111", "00000000", "87654321", "qwertyui", "qwertyuiop", "qwerty123", "1q2w3e4r", "1qaz2wsx", "asdfghjk",
  "zxcvbnm1", "iloveyou", "sunshine", "princess", "football", "baseball", "superman", "trustno1", "welcome1",
  "letmein1", "abcdefgh", "abc12345", "monkey12", "dragon12", "master12", "starwars", "whatever", "computer",
  "internet", "michelle", "jennifer", "corvette", "mercedes", "liverpool", "chelsea1", "changeme", "viscera1",
  "anatomy1", "password!", "qwerty12", "aa123456", "admin123",
]);

const ROWS = ["abcdefghijklmnopqrstuvwxyz", "qwertyuiop", "asdfghjkl", "zxcvbnm", "0123456789", "1234567890"];

function isRun(text: string): boolean {
  if (text.length < 6) return false;
  if (/^(.)\1+$/.test(text)) return true;
  for (const row of ROWS) {
    const reversed = [...row].reverse().join("");
    if (row.includes(text) || reversed.includes(text)) return true;
  }
  // "abcabcabc", "12121212": a short unit repeated
  return /^(.{1,4})\1{2,}$/.test(text);
}

function characterClasses(text: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(text)).length;
}

/** Words the password should not be built from: the name, the email's local part, the username (≥ 4 characters). */
function personalWords(context: readonly string[]): string[] {
  const words = new Set<string>();
  for (const raw of context) {
    const value = raw.trim().toLowerCase();
    if (value === "") continue;
    const local = value.includes("@") ? value.slice(0, value.indexOf("@")) : value;
    for (const part of [local, ...local.split(/[\s._@+-]+/)]) if (part.length >= 4) words.add(part);
  }
  return [...words];
}

export function passwordStrength(password: string, context: readonly string[] = []): PasswordStrength {
  if (password.length === 0) {
    return { level: "empty", score: 0, label: "", hint: `Use at least ${MIN_PASSWORD_LENGTH} characters.`, acceptable: false };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    const missing = MIN_PASSWORD_LENGTH - password.length;
    return {
      level: "short",
      score: 0,
      label: "Too Short",
      hint: `Use at least ${MIN_PASSWORD_LENGTH} characters (${missing} more).`,
      acceptable: false,
    };
  }
  const lower = password.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]+$/g, "").replace(/\d+$/g, "");
  const personal = personalWords(context).some((word) => lower.includes(word));
  if (COMMON.has(lower) || COMMON.has(stripped) || isRun(lower) || isRun(stripped) || personal) {
    return {
      level: "weak",
      score: 1,
      label: "Weak",
      hint: personal ? "Avoid your name, username or email in your password." : "Avoid common passwords, keyboard runs and repeats.",
      acceptable: true,
    };
  }
  const classes = characterClasses(password);
  const unique = new Set(password).size;
  if (password.length >= 16 || (password.length >= 12 && classes >= 3 && unique >= 8)) {
    return { level: "strong", score: 4, label: "Strong", hint: "This password is hard to guess.", acceptable: true };
  }
  if (password.length >= 12 || (classes >= 3 && unique >= 6)) {
    return { level: "good", score: 3, label: "Good", hint: "A few more characters make it even harder to guess.", acceptable: true };
  }
  return { level: "fair", score: 2, label: "Fair", hint: "Longer is stronger: try a short phrase of a few words.", acceptable: true };
}
