import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllLocalAccountDataForTests,
  createAccountClient,
  localCurrentUser,
  localDeleteAccount,
  localDeleteItem,
  localGetItem,
  localListItems,
  localLogin,
  localLogout,
  localRegister,
  localSaveItem,
  validateEmail,
  validateName,
  validatePassword,
} from "./accountStorage";

describe("accountStorage (browser-local PBKDF2 + isolated storage)", () => {
  beforeEach(async () => {
    await clearAllLocalAccountDataForTests();
  });

  it("validates email, name, and password rules", () => {
    expect(validateEmail("  Surgeon@Hospital.ORG ")).toBe("surgeon@hospital.org");
    expect(() => validateEmail("invalid-email")).toThrow("Enter a valid email address.");
    expect(validateName("  Dr.Vesalius  ")).toBe("Dr.Vesalius");
    expect(() => validateName("   ")).toThrow("Enter your name to create an account.");
    expect(validatePassword("12345678")).toBe("12345678");
    expect(() => validatePassword("short")).toThrow("Password must be at least 8 characters.");
  });

  it("registers, persists session, rejects duplicates, logs out, and logs back in", async () => {
    expect(await localCurrentUser()).toBeNull();

    const user = await localRegister("Ada@Example.org", "Ada Lovelace", "correct-horse-battery");
    expect(user.email).toBe("ada@example.org");
    expect(user.name).toBe("Ada Lovelace");
    expect((await localCurrentUser())?.id).toBe(user.id);

    await expect(
      localRegister("ada@example.org", "Duplicate", "another-password"),
    ).rejects.toThrow("An account with this email already exists.");

    await localLogout();
    expect(await localCurrentUser()).toBeNull();

    await expect(localLogin("ada@example.org", "wrong-password")).rejects.toThrow(
      "Invalid email or password.",
    );

    const relogged = await localLogin("ADA@example.org", "correct-horse-battery");
    expect(relogged.id).toBe(user.id);
    expect((await localCurrentUser())?.email).toBe("ada@example.org");
  });

  it("isolates saved items per user and cascades on account deletion", async () => {
    const client = createAccountClient("browser-local");

    // User A registers and saves two items
    const userA = await client.register("alpha@viscera.org", "Surgeon Alpha", "alpha-password-123");
    const savedA1 = await client.saveItem({
      title: "Liver guided seed 1 · wet 95%",
      kind: "tissue-material",
      summary: "Liver capsule · vessels 70% · wet 95%",
      payload: {
        selected: "learned-guided-liver-parenchyma-lobular-s01",
        controls: { vessels: 0.7, wetness: 0.95 },
      },
    });
    const savedA2 = await client.saveItem({
      title: "Gallbladder studio variation",
      kind: "studio-project",
      summary: "Gallbladder · seed 108",
      payload: { draft: { reference_id: "gallbladder", seed: 108 } },
    });

    const listA = await client.listItems();
    expect(listA.map((i) => i.id)).toEqual([savedA2.id, savedA1.id]);

    // Switch to User B
    await client.logout();
    const userB = await client.register("bravo@viscera.org", "Surgeon Bravo", "bravo-password-456");
    expect(userB.id).not.toBe(userA.id);

    // User B sees 0 items and cannot access or delete User A's items
    expect(await client.listItems()).toEqual([]);
    await expect(client.getItem(savedA1.id)).rejects.toThrow("Saved item not found.");
    await expect(client.deleteItem(savedA1.id)).rejects.toThrow("Saved item not found.");

    // User B saves their own item
    const savedB1 = await client.saveItem({
      title: "Pancreas clean seed 3",
      kind: "tissue-material",
      summary: "Pancreas lobules · 512px",
      payload: { selected: "learned-clean-pancreas-acinar-lobulated-s03" },
    });
    expect((await client.listItems()).map((i) => i.id)).toEqual([savedB1.id]);

    // Switch back to User A, verify items intact, delete one item, then delete User A's account
    await client.logout();
    await client.login("alpha@viscera.org", "alpha-password-123");
    const loadedA1 = await localGetItem(savedA1.id);
    expect(loadedA1.payload).toEqual({
      selected: "learned-guided-liver-parenchyma-lobular-s01",
      controls: { vessels: 0.7, wetness: 0.95 },
    });

    await localDeleteItem(savedA2.id);
    expect((await localListItems()).map((i) => i.id)).toEqual([savedA1.id]);

    await localDeleteAccount();
    expect(await localCurrentUser()).toBeNull();
    await expect(localLogin("alpha@viscera.org", "alpha-password-123")).rejects.toThrow(
      "Invalid email or password.",
    );

    // User B's account and saved item remain untouched
    await client.login("bravo@viscera.org", "bravo-password-456");
    expect((await client.listItems()).map((i) => i.id)).toEqual([savedB1.id]);
  });
});

