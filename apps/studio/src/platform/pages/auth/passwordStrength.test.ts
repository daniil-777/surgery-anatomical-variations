import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, passwordStrength } from "./passwordStrength";

describe("password strength hint", () => {
  it("only refuses passwords shorter than the server's minimum", () => {
    expect(passwordStrength("")).toMatchObject({ level: "empty", acceptable: false, label: "" });
    expect(passwordStrength("abc")).toMatchObject({ level: "short", acceptable: false, label: "Too Short" });
    expect(passwordStrength("abc").hint).toMatch(/5 more/);
    expect(passwordStrength("x".repeat(MIN_PASSWORD_LENGTH - 1)).acceptable).toBe(false);
    for (const password of ["password", "aaaaaaaa", "Tr0ub4dor&3", "correct horse battery staple"]) {
      expect(passwordStrength(password).acceptable, password).toBe(true);
    }
  });

  it("flags common passwords, keyboard runs and repeats as weak", () => {
    for (const password of ["password", "Password1", "12345678", "qwertyuiop", "qwerty123!", "aaaaaaaa", "abcabcabc", "zyxwvuts", "87654321"]) {
      expect(passwordStrength(password).level, password).toBe("weak");
    }
  });

  it("flags passwords built from the person's name, username or email", () => {
    const context = ["Daniil Emtsev", "daniil.emtsev@example.com", "dan_e"];
    expect(passwordStrength("daniil2026!", context)).toMatchObject({ level: "weak", hint: "Avoid your name, username or email in your password." });
    expect(passwordStrength("Emtsev#Lab9", context).level).toBe("weak");
    // short fragments do not count (no false alarms for three-letter names)
    expect(passwordStrength("abundance-river", ["Dan"]).level).not.toBe("weak");
  });

  it("rewards length first, without composition rules", () => {
    expect(passwordStrength("riverbend").level).toBe("fair");
    expect(passwordStrength("riverbend lamp").level).toBe("good");
    expect(passwordStrength("Tr0ub4dor&3").level).toBe("good");
    expect(passwordStrength("correct horse battery").level).toBe("strong");
    expect(passwordStrength("Liver-Lobe-42-Wide").level).toBe("strong");
    expect(passwordStrength("Kp9#vLq2!xZ7").level).toBe("strong");
  });

  it("scores in step with the level", () => {
    const order = ["short", "weak", "fair", "good", "strong"] as const;
    const samples = ["abc", "password", "riverbend", "riverbend lamp", "correct horse battery"];
    samples.forEach((password, index) => {
      const result = passwordStrength(password);
      expect(result.level).toBe(order[index]);
      expect(result.score).toBe(index === 0 ? 0 : index);
    });
  });
});
