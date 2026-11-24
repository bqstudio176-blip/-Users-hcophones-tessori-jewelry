import { z } from "zod";

/** Form schemas shared by server actions. All input is validated server-side. */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Email is too long")
  .pipe(z.email("Enter a valid email address"));

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(72, "Use at most 72 characters")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[0-9]/, "Include a number");

export const signUpSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your name").max(120),
  email: emailSchema,
  password: passwordSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password").max(72),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password").max(72),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  })
  .refine((v) => v.password !== v.currentPassword, {
    message: "Choose a different password",
    path: ["password"],
  });

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

export const workspaceNameSchema = z.string().trim().min(2, "Use at least 2 characters").max(80, "Use at most 80 characters");

export const createWorkspaceSchema = z.object({
  name: workspaceNameSchema,
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, "3–48 characters: lowercase letters, numbers and dashes; no leading/trailing dash"),
});

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .transform((v) => (v === "" ? null : v));

export const workspaceSettingsSchema = z.object({
  name: workspaceNameSchema,
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone"),
  defaultLanguage: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Use a code like en or es-MX"),
  contentNiche: optionalText(120),
  brandVoice: optionalText(2000),
  targetAudience: optionalText(2000),
});

export const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your name").max(120),
  avatarUrl: z
    .string()
    .trim()
    .max(2048)
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || /^https:\/\/\S+$/.test(v), "Use an https:// URL"),
});

export const preferencesSchema = z.object({
  theme: z.enum(["dark", "light", "system"]),
  emailProductUpdates: z.boolean(),
  emailWeeklySummary: z.boolean(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const DEFAULT_PREFERENCES: Preferences = {
  theme: "dark",
  emailProductUpdates: true,
  emailWeeklySummary: false,
};
export function parsePreferences(raw: unknown): Preferences {
  const result = preferencesSchema.partial().safeParse(raw ?? {});
  return { ...DEFAULT_PREFERENCES, ...(result.success ? result.data : {}) };
}

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(["admin", "member"]),
});

export const uuidSchema = z.uuid();

export const creditAdjustmentSchema = z.object({
  workspaceId: uuidSchema,
  amount: z.coerce
    .number()
    .int("Use a whole number")
    .refine((n) => n !== 0, "Amount cannot be zero")
    .refine((n) => Math.abs(n) <= 1_000_000, "Amount is too large"),
  reason: z.string().trim().min(3, "Give a reason (3+ characters)").max(200),
});

/** Flattens a ZodError into { field: firstMessage }. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
