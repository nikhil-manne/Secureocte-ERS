/**
 * middlewares/validationSchemas.js
 * ─────────────────────────────────────────────────────────────
 * Zod schemas for all request bodies that flow through validate().
 * ─────────────────────────────────────────────────────────────
 */

import { z } from "zod";

/* ── Panic trigger ── */
export const panicSchema = z.object({
  latitude:    z.number().min(-90).max(90),
  longitude:   z.number().min(-180).max(180),
  accuracy:    z.number().optional(),
  alertReason: z.string().max(200).optional(),
});

/* ── Stream ── */
export const streamSchema = z.object({
  streamId: z.string().uuid("streamId must be a valid UUID"),
});

/* ── Stream create ── */
export const streamCreateSchema = z.object({
  userId: z.string().min(1).max(200),
});

/* ── Location update ── */
export const locationUpdateSchema = z.object({
  alertId:   z.string().uuid(),
  latitude:  z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy:  z.number().optional(),
});

/* ── Auth: signup ── */
export const signupSchema = z.object({
  username:        z.string().min(3).max(50),
  password:        z.string().min(6).max(128),
  mobile:          z.string().regex(/^[0-9]{10}$/, "Mobile must be 10 digits"),
  trustedContacts: z.array(z.any()).optional(),
  deviceId:        z.string().optional(),
});

/* ── Auth: login ── */
export const loginSchema = z.object({
  mobile:   z.string().regex(/^[0-9]{10}$/),
  password: z.string().min(1).max(128),
  deviceId: z.string().optional(),
});
