import { z } from "zod";

export const pinLoginSchema = z.object({
  pin: z.string().regex(/^\d{8,12}$/, "PIN must contain 8 to 12 digits."),
  label: z.string().trim().min(1).max(80).optional()
});

export const qualityRequestSchema = z.object({
  preset: z.enum(["low-latency", "balanced", "high-quality"])
});

export const deviceApprovalSchema = z.object({
  approved: z.boolean()
});

export const deviceIdSchema = z.string().min(1).max(64);

const iceCandidateSchema = z
  .object({
    candidate: z.string().max(16_384),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(128).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional()
  })
  .passthrough();

export const signalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("offer"),
    sdp: z.string().min(1).max(256_000)
  }),
  z.object({
    type: z.literal("ice"),
    candidate: iceCandidateSchema
  }),
  z.object({ type: z.literal("close") })
]);

const inputButtonSchema = z.enum(["left", "right", "middle"]);
const coordinateSchema = z.number().finite().int().min(-100_000).max(100_000);

export const controlMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouseMove"),
    dx: coordinateSchema,
    dy: coordinateSchema
  }),
  z.object({
    type: z.literal("mouseAbs"),
    x: coordinateSchema,
    y: coordinateSchema
  }),
  z.object({
    type: z.literal("mouseButton"),
    button: inputButtonSchema,
    down: z.boolean()
  }),
  z.object({ type: z.literal("click"), button: inputButtonSchema }),
  z.object({ type: z.literal("doubleClick"), button: inputButtonSchema }),
  z.object({
    type: z.literal("wheel"),
    delta: z.number().finite().int().min(-10_000).max(10_000)
  }),
  z.object({
    type: z.literal("key"),
    key: z.string().min(1).max(64),
    down: z.boolean()
  }),
  z.object({
    type: z.literal("shortcut"),
    keys: z.array(z.string().min(1).max(64)).min(1).max(8)
  }),
  z.object({
    type: z.literal("text"),
    text: z.string().max(4_096)
  }),
  z.object({
    type: z.literal("setQuality"),
    preset: z.enum(["low-latency", "balanced", "high-quality"])
  }),
  z.object({
    type: z.literal("selectMonitor"),
    monitorIndex: z.number().int().min(0).max(32)
  }),
  z.object({
    type: z.literal("ping"),
    sentAt: z.number().finite().int().nonnegative()
  })
]);
