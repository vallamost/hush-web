import { z } from "zod"

const NonEmptyString = z.string().min(1)
const OptionalString = z.string().optional()
const OptionalNullableString = z.string().nullable().optional()

const BaseMessageSchema = z.object({
  type: NonEmptyString,
}).passthrough()

const ServerScopedSchema = z.object({
  type: NonEmptyString,
  server_id: NonEmptyString,
}).passthrough()

const ChannelScopedSchema = z.object({
  type: NonEmptyString,
  channel_id: NonEmptyString,
  server_id: OptionalString,
}).passthrough()

const RawChannelSchema = z.object({
  id: NonEmptyString,
  type: NonEmptyString,
  name: OptionalString,
  encryptedMetadata: OptionalNullableString,
  parentId: z.string().nullable(),
  position: z.number(),
  server_id: OptionalString,
}).passthrough()

const SystemMessageSchema = z.object({
  id: NonEmptyString,
  eventType: NonEmptyString,
  actorId: NonEmptyString,
  createdAt: NonEmptyString,
}).passthrough()

const VoiceParticipantSchema = z.object({
  userId: NonEmptyString,
  displayName: z.string(),
}).passthrough()

const WS_MESSAGE_SCHEMAS = new Map([
  [
    "pong",
    z.object({
      type: z.literal("pong"),
    }).passthrough(),
  ],
  [
    "error",
    z.object({
      type: z.literal("error"),
      code: OptionalString,
    }).passthrough(),
  ],
  [
    "message.new",
    z.object({
      type: z.literal("message.new"),
      id: NonEmptyString,
      channel_id: NonEmptyString,
    }).passthrough(),
  ],
  [
    "message.send.ack",
    z.object({
      type: z.literal("message.send.ack"),
      channel_id: NonEmptyString,
      local_id: NonEmptyString,
    }).passthrough(),
  ],
  [
    "presence.update",
    z.object({
      type: z.literal("presence.update"),
      user_ids: z.array(NonEmptyString),
    }).passthrough(),
  ],
  [
    "channel_created",
    z.object({
      type: z.literal("channel_created"),
      channel: RawChannelSchema,
      server_id: OptionalString,
    }).passthrough(),
  ],
  [
    "channel_deleted",
    z.object({
      type: z.literal("channel_deleted"),
      channel_id: NonEmptyString,
      server_id: OptionalString,
    }).passthrough(),
  ],
  [
    "channel_moved",
    z.object({
      type: z.literal("channel_moved"),
      channel_id: NonEmptyString,
      parent_id: z.string().nullable(),
      position: z.number(),
      server_id: OptionalString,
    }).passthrough(),
  ],
  ["server_updated", ServerScopedSchema],
  ["server_deleted", ServerScopedSchema],
  ["member_joined", ServerScopedSchema],
  ["member_left", ServerScopedSchema],
  [
    "member_kicked",
    ServerScopedSchema.extend({
      user_id: OptionalString,
      reason: OptionalString,
    }),
  ],
  [
    "member_banned",
    ServerScopedSchema.extend({
      user_id: OptionalString,
      reason: OptionalString,
    }),
  ],
  [
    "member_muted",
    ServerScopedSchema.extend({
      user_id: OptionalString,
      permission_level: z.number().optional(),
      reason: OptionalString,
    }),
  ],
  [
    "member_role_changed",
    ServerScopedSchema.extend({
      user_id: OptionalString,
      permission_level: z.number().optional(),
    }),
  ],
  [
    "system_message",
    z.object({
      type: z.literal("system_message"),
      server_id: OptionalString,
      system_message: SystemMessageSchema,
    }).passthrough(),
  ],
  [
    "mls.commit",
    z.object({
      type: z.literal("mls.commit"),
      channel_id: NonEmptyString,
      commit_bytes: NonEmptyString,
      sender_id: OptionalString,
      sender_device_id: OptionalString,
      group_type: OptionalString,
      epoch: z.number().optional(),
    }).passthrough(),
  ],
  [
    "mls.add_request",
    z.object({
      type: z.literal("mls.add_request"),
      channel_id: NonEmptyString,
      action: OptionalString,
      proposal_bytes: OptionalString,
      requester_id: OptionalString,
      requester_device_id: OptionalString,
    }).passthrough(),
  ],
  [
    "voice_state_update",
    ChannelScopedSchema.extend({
      participants: z.array(VoiceParticipantSchema).optional(),
    }),
  ],
  ["voice_group_destroyed", ChannelScopedSchema],
  [
    "voice.mute_state",
    ChannelScopedSchema.extend({
      user_id: NonEmptyString,
      is_muted: z.boolean(),
      is_deafened: z.boolean(),
    }),
  ],
  [
    "transparency.key_change",
    z.object({
      type: z.literal("transparency.key_change"),
      operation: NonEmptyString,
      leafIndex: z.number(),
      treeRoot: NonEmptyString,
    }).passthrough(),
  ],
  [
    "instance_banned",
    z.object({
      type: z.literal("instance_banned"),
      reason: z.string(),
    }).passthrough(),
  ],
  [
    "key_packages.low",
    z.object({
      type: z.literal("key_packages.low"),
    }).passthrough(),
  ],
  [
    "instance_updated",
    z.object({
      type: z.literal("instance_updated"),
      name: OptionalString,
      iconUrl: z.string().nullable().optional(),
      icon_url: z.string().nullable().optional(),
      registrationMode: OptionalString,
      registration_mode: OptionalString,
      guild_discovery: OptionalString,
      server_creation_policy: OptionalString,
      screen_share_resolution_cap: OptionalString,
      max_attachment_bytes: z.number().optional(),
      message_retention_days: z.number().optional(),
      voice_key_rotation_hours: z.number().optional(),
    }),
  ],
])

function formatIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
  }))
}

export function parseWsMessage(data) {
  const base = BaseMessageSchema.safeParse(data)
  if (!base.success) {
    return {
      ok: false,
      type: null,
      reason: "missing_type",
      issues: formatIssues(base.error),
    }
  }

  const schema = WS_MESSAGE_SCHEMAS.get(base.data.type)
  if (!schema) {
    return {
      ok: true,
      data: base.data,
      known: false,
    }
  }

  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    return {
      ok: false,
      type: base.data.type,
      reason: "schema",
      issues: formatIssues(parsed.error),
    }
  }

  return {
    ok: true,
    data: parsed.data,
    known: true,
  }
}

export function isKnownWsMessageType(type) {
  return WS_MESSAGE_SCHEMAS.has(type)
}
