import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  createWorkspaceSchema,
  creditAdjustmentSchema,
  parsePreferences,
  passwordSchema,
  signUpSchema,
  slugify,
  SLUG_PATTERN,
  workspaceSettingsSchema,
} from "@/lib/validation";

describe("auth validation", () => {
  it("enforces password policy", () => {
    expect(passwordSchema.safeParse("Short1").success).toBe(false);
    expect(passwordSchema.safeParse("alllowercase1").success).toBe(false);
    expect(passwordSchema.safeParse("ALLUPPERCASE1").success).toBe(false);
    expect(passwordSchema.safeParse("NoDigitsHere").success).toBe(false);
    expect(passwordSchema.safeParse("Valid-Passw0rd").success).toBe(true);
    expect(passwordSchema.safeParse("A1" + "a".repeat(80)).success).toBe(false);
  });
  it("normalises email and rejects malformed ones", () => {
    const ok = signUpSchema.safeParse({ fullName: "Ada", email: "  ADA@Example.COM ", password: "Valid-Passw0rd" });
    expect(ok.success && ok.data.email).toBe("ada@example.com");
    expect(signUpSchema.safeParse({ fullName: "Ada", email: "not-an-email", password: "Valid-Passw0rd" }).success).toBe(false);
  });
  it("requires matching and different passwords on change", () => {
    expect(changePasswordSchema.safeParse({ currentPassword: "Old-Passw0rd", password: "New-Passw0rd1", confirmPassword: "nope" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "Same-Passw0rd", password: "Same-Passw0rd", confirmPassword: "Same-Passw0rd" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "Old-Passw0rd", password: "New-Passw0rd1", confirmPassword: "New-Passw0rd1" }).success).toBe(true);
  });
});

describe("workspace validation", () => {
  it("slugify produces DB-valid slugs", () => {
    for (const input of ["Acme Studio", "  Café Ñandú!!  ", "a--b", "Über Brand 2026", "x".repeat(80)]) {
      const s = slugify(input);
      expect(s).toMatch(SLUG_PATTERN);
    }
    expect(slugify("Café Ñandú")).toBe("cafe-nandu");
  });
  it("matches the database slug constraint", () => {
    expect(createWorkspaceSchema.safeParse({ name: "Ok", slug: "ok-slug" }).success).toBe(true);
    for (const bad of ["-lead", "trail-", "a", "has space", "UPPER_case", "x".repeat(49)]) {
      expect(createWorkspaceSchema.safeParse({ name: "Ok", slug: bad.toLowerCase() === bad ? bad : bad }).success, bad).toBe(false);
    }
  });
  it("validates timezone and language", () => {
    const base = { name: "WS", timezone: "Europe/Madrid", defaultLanguage: "es", contentNiche: "", brandVoice: "", targetAudience: "" };
    const ok = workspaceSettingsSchema.safeParse(base);
    expect(ok.success && ok.data.contentNiche).toBe(null);
    expect(workspaceSettingsSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(workspaceSettingsSchema.safeParse({ ...base, defaultLanguage: "english" }).success).toBe(false);
  });
});

describe("credit adjustment validation", () => {
  const id = "3f1c2a64-8a0e-4c39-9b7f-0d6c1a2b3c4d";
  it("requires a non-zero integer and a reason", () => {
    expect(creditAdjustmentSchema.safeParse({ workspaceId: id, amount: "10", reason: "goodwill" }).success).toBe(true);
    expect(creditAdjustmentSchema.safeParse({ workspaceId: id, amount: "0", reason: "goodwill" }).success).toBe(false);
    expect(creditAdjustmentSchema.safeParse({ workspaceId: id, amount: "1.5", reason: "goodwill" }).success).toBe(false);
    expect(creditAdjustmentSchema.safeParse({ workspaceId: id, amount: "5", reason: "" }).success).toBe(false);
    expect(creditAdjustmentSchema.safeParse({ workspaceId: "nope", amount: "5", reason: "goodwill" }).success).toBe(false);
  });
});

describe("preferences", () => {
  it("fills defaults and ignores invalid stored values", () => {
    expect(parsePreferences({})).toEqual({ theme: "dark", emailProductUpdates: true, emailWeeklySummary: false });
    expect(parsePreferences({ theme: "light" }).theme).toBe("light");
    expect(parsePreferences({ theme: "neon" }).theme).toBe("dark");
    expect(parsePreferences(null).theme).toBe("dark");
  });
});
