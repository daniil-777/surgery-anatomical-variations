import { describe, expect, it } from "vitest";
import { isValidUsername } from "../../core/memory/rules";
import { classifyIdentifier, isEmailAddress, normalizeUsernameInput, usernameProblem } from "./identifier";

describe("sign-in identifiers", () => {
  it("treats anything with an @ as an email address, lower-cased and trimmed", () => {
    expect(classifyIdentifier("  Daniil.Emtsev@Example.COM ", { usernames: true })).toEqual({ kind: "email", value: "daniil.emtsev@example.com" });
    expect(classifyIdentifier("a@b.co", { usernames: false })).toEqual({ kind: "email", value: "a@b.co" });
  });

  it("rejects malformed email addresses with a field message", () => {
    expect(classifyIdentifier("daniil@", { usernames: true })).toEqual({ kind: "invalid", problem: "Enter a valid email address." });
    expect(classifyIdentifier("a b@c.d", { usernames: true }).kind).toBe("invalid");
    expect(classifyIdentifier("@example.com", { usernames: true }).kind).toBe("invalid");
  });

  it("treats everything else as a username when usernames are enabled", () => {
    expect(classifyIdentifier("Daniil", { usernames: true })).toEqual({ kind: "username", value: "daniil" });
    expect(classifyIdentifier("dr.who-42", { usernames: true })).toEqual({ kind: "username", value: "dr.who-42" });
    // reserved names classify as usernames: the server answers them like any wrong sign-in (no enumeration)
    expect(classifyIdentifier("admin", { usernames: true })).toEqual({ kind: "username", value: "admin" });
  });

  it("asks for an email address when usernames are off", () => {
    expect(classifyIdentifier("daniil", { usernames: false })).toEqual({ kind: "invalid", problem: "Enter a valid email address." });
    expect(classifyIdentifier("   ", { usernames: false })).toEqual({ kind: "invalid", problem: "Enter your email address." });
  });

  it("explains empty and impossible identifiers", () => {
    expect(classifyIdentifier("", { usernames: true })).toEqual({ kind: "invalid", problem: "Enter your email address or username." });
    expect(classifyIdentifier("no spaces", { usernames: true })).toEqual({ kind: "invalid", problem: "Enter a valid email address or username." });
    expect(classifyIdentifier("ab", { usernames: true }).kind).toBe("invalid");
  });

  it("recognises email addresses", () => {
    expect(isEmailAddress("x@y.z")).toBe(true);
    expect(isEmailAddress(" x@y.z ")).toBe(true);
    expect(isEmailAddress("x@y")).toBe(false);
    expect(isEmailAddress("xy.z")).toBe(false);
  });
});

describe("username rules", () => {
  it("accepts what the database accepts", () => {
    for (const name of ["daniil", "d.emtsev", "dan_2026", "a-b", "abc", "x".repeat(30)]) {
      expect(usernameProblem(name), name).toBeNull();
      expect(isValidUsername(normalizeUsernameInput(name)), name).toBe(true);
    }
    // upper case is lowered first, as the database stores it
    expect(usernameProblem("Daniil")).toBeNull();
    expect(usernameProblem("")).toBeNull();
  });

  it("says what is wrong with names the database refuses", () => {
    const cases: Array<[string, RegExp]> = [
      ["ab", /at least 3/],
      ["x".repeat(31), /at most 30/],
      ["dan iil", /only letters, numbers/],
      ["dän", /only letters, numbers/],
      [".daniil", /Start and end/],
      ["daniil-", /Start and end/],
      ["dan..iil", /next to each other/],
      ["dan_-iil", /next to each other/],
      ["admin", /reserved/],
      ["Settings", /reserved/],
    ];
    for (const [name, message] of cases) {
      expect(usernameProblem(name), name).toMatch(message);
      expect(isValidUsername(normalizeUsernameInput(name)), name).toBe(false);
    }
  });
});
