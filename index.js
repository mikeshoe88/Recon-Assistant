// index.js (ESM) — Recon Assistant (Socket Mode)
// Core features:
//  - When bot joins a recon channel (name contains "rcn"), invite required users + PM
//  - Reaction ✅ on a message posts that message to the Pipedrive deal as a note (deal inferred from channel name "deal###")

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import bolt from "@slack/bolt";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";

/* =========================
   ENV
========================= */
const PORT = Number(process.env.PORT || 3000);

// Slack
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;         // xapp-...
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;         // xoxb-...
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "unused_in_socket_mode";

// Pipedrive
const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

// Optional feature toggles
const ENABLE_REACTION_TO_PD_NOTE = (process.env.ENABLE_REACTION_TO_PD_NOTE || "true") !== "false";
const REACTION_UPLOAD_FILES = (process.env.REACTION_UPLOAD_FILES || "false") === "true";

// Recon channel detection
// You said recon channels will be like "...rcn..." (prefix/suffix doesn’t matter) and includes deal id in name.
const RECON_CHANNEL_REGEX = new RegExp(process.env.RECON_CHANNEL_REGEX || "rcn", "i"); // default: contains "rcn"

// Pipedrive “Project Manager” custom field key (40-hex key)
// Put your real PM field key in Railway variables as PM_FIELD_KEY.
// If you don’t know it yet, leave it blank and we’ll fall back to probing on the deal payload.
const PM_FIELD_KEY = process.env.PM_FIELD_KEY || "";

/* =========================
   ALWAYS INVITE
   (you requested Ariel, Ryan, Lamar ALWAYS on recon channels)
========================= */
const ALWAYS_INVITE_USER_IDS = [
  "U09PUG47MAM", // Ariel
  "U05G8MQ54JD", // Ryan
  "U086RE5K3LY", // Lamar
];

// Optional: your existing “core always invite” list (keep/expand as needed)
const CORE_INVITE_USER_IDS = [
  // "U07AB7A4UNS", // Anastacio
  // "U0A7S1K86CX", // Lana
  // "U05FYG3EMHS", // Kim
  // "U06DKJ1BJ9W", // Danica
  // "U05FPCPHJG6", // Mike
].filter(Boolean);

// Final invite set = REQUIRED + CORE
function getInviteList() {
  return Array.from(new Set([...ALWAYS_INVITE_USER_IDS, ...CORE_INVITE_USER_IDS]));
}

/* =========================
   PM MAPPING (Pipedrive enum ID -> Slack user ID)
   You asked: "keys + IDs + what they're referencing".
   This is the structure you want.

   Put your REAL mappings here once you confirm the PM enum IDs.
========================= */
const PM_ENUM_ID_TO_NAME = {
  // Example:
  // 101: "Johnathan",
  // 102: "Pena",
  // 103: "Hector",
};

const PM_ENUM_ID_TO_SLACK = {
  // Example:
  // 101: "U0XXXXXXX", // Johnathan
  // 102: "U0YYYYYYY", // Pena
  // 103: "U05TUQ48UBU", // Hector
};

/* =========================
   Slack App (Socket Mode)
========================= */
if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) {
  console.error("❌ Missing SLACK_APP_TOKEN (xapp-...) or SLACK_BOT_TOKEN (xoxb-...). Set Railway Variables.");
  process.exit(1);
}

const { App } = bolt;

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
});

/* =========================
   Small web server for Railway health checks
========================= */
const web = express();
web.get("/", (_req, res) => res.status(200).send("Recon Assistant OK"));
web.get("/healthz", (_req, res) => res.status(200).send("ok"));
web.listen(PORT, () => console.log(`🌐 Health server on :${PORT}`));

/* =========================
   Helpers
========================= */
const DEBUG = (process.env.DEBUG || "false") === "true";
const dbg = (...args) => DEBUG && console.log("[DBG]", ...args);

function extractDealIdFromChannelName(channelName = "") {
  // Looks for "deal123" anywhere in channel name
  const m = String(channelName).match(/deal(\d+)/i);
  return m ? m[1] : null;
}

function isReconChannelName(channelName = "") {
  return RECON_CHANNEL_REGEX.test(channelName);
}

async function safeConversationsInvite(channel, userIds = []) {
  if (!channel || !userIds.length) return;
  // Slack API limit: up to 1000 users, but practical is smaller.
  // Invite in chunks of 30 to be safe.
  const chunkSize = 30;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    try {
      await app.client.conversations.invite({
        channel,
        users: chunk.join(","),
      });
      dbg("invited chunk", chunk);
    } catch (e) {
      // Common non-fatal errors: already_in_channel, cant_invite_self, not_in_channel
      dbg("invite error", e?.data || e?.message || e);
    }
  }
}

async function ensureBotInChannel(channelId) {
  if (!channelId) return;
  try {
    await app.client.conversations.join({ channel: channelId });
  } catch (e) {
    // ignore (already in channel / can't join private, etc.)
  }
}

/* =========================
   Pipedrive helpers
========================= */
async function pdGet(url) {
  if (!PIPEDRIVE_API_TOKEN) throw new Error("Missing PIPEDRIVE_API_TOKEN");
  const full = `https://api.pipedrive.com/v1/${url}${url.includes("?") ? "&" : "?"}api_token=${encodeURIComponent(PIPEDRIVE_API_TOKEN)}`;
  const r = await axios.get(full);
  return r.data;
}

async function pdPost(url, payload) {
  if (!PIPEDRIVE_API_TOKEN) throw new Error("Missing PIPEDRIVE_API_TOKEN");
  const full = `https://api.pipedrive.com/v1/${url}${url.includes("?") ? "&" : "?"}api_token=${encodeURIComponent(PIPEDRIVE_API_TOKEN)}`;
  const r = await axios.post(full, payload, { headers: { "Content-Type": "application/json" } });
  return r.data;
}

function normalizeEnumValue(v) {
  // PD custom field enum values come as number, string, or { value, label }
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  if (typeof v === "object" && v.value != null) {
    if (typeof v.value === "number") return v.value;
    if (typeof v.value === "string" && /^\d+$/.test(v.value)) return Number(v.value);
  }
  return null;
}

function probeLikelyPmField(deal) {
  // If you don’t yet know PM_FIELD_KEY, this tries to find a field shaped like an enum
  // whose label matches one of your PM names (once you populate PM_ENUM_ID_TO_NAME).
  const knownNames = new Set(
    Object.values(PM_ENUM_ID_TO_NAME).map((s) => String(s || "").trim().toLowerCase()).filter(Boolean)
  );
  if (!knownNames.size) return null;

  for (const [k, v] of Object.entries(deal || {})) {
    if (!/^[a-f0-9]{40}$/i.test(k)) continue; // PD custom field keys are 40 hex chars
    if (v && typeof v === "object" && typeof v.label === "string") {
      const label = v.label.trim().toLowerCase();
      if (knownNames.has(label)) return { key: k, value: v };
    }
    if (typeof v === "string") {
      const label = v.trim().toLowerCase();
      if (knownNames.has(label)) return { key: k, value: v };
    }
  }
  return null;
}

async function fetchDeal(dealId) {
  if (!dealId) return null;
  const j = await pdGet(`deals/${encodeURIComponent(dealId)}?return_field_key=1`);
  return j?.success ? j.data : null;
}

function readPmFromDeal(deal) {
  if (!deal) return { pmEnumId: null, pmName: null, pmFieldKeyUsed: null };

  // 1) Use explicit PM_FIELD_KEY if provided
  if (PM_FIELD_KEY && deal[PM_FIELD_KEY] != null) {
    const v = deal[PM_FIELD_KEY];
    const id = normalizeEnumValue(v);
    const label = (typeof v === "object" && typeof v.label === "string") ? v.label : null;
    const pmName = label || (id != null ? PM_ENUM_ID_TO_NAME[id] : null) || (typeof v === "string" ? v : null);
    return { pmEnumId: id, pmName: pmName || null, pmFieldKeyUsed: PM_FIELD_KEY };
  }

  // 2) Probe if you haven’t put PM_FIELD_KEY yet
  const probed = probeLikelyPmField(deal);
  if (probed) {
    const v = probed.value;
    const id = normalizeEnumValue(v);
    const label = (typeof v === "object" && typeof v.label === "string") ? v.label : null;
    const pmName = label || (id != null ? PM_ENUM_ID_TO_NAME[id] : null) || (typeof v === "string" ? v : null);
    return { pmEnumId: id, pmName: pmName || null, pmFieldKeyUsed: probed.key };
  }

  return { pmEnumId: null, pmName: null, pmFieldKeyUsed: null };
}

/* =========================
   BOT JOINED CHANNEL → INVITE EVERYONE + PM
========================= */
let BOT_USER_ID = null;

async function initBotIdentity() {
  try {
    const auth = await app.client.auth.test();
    BOT_USER_ID = auth?.user_id || null;
    console.log("🤖 Bot user id:", BOT_USER_ID);
  } catch (e) {
    console.warn("⚠️ auth.test failed:", e?.data || e?.message || e);
  }
}

async function handleBotJoinedChannel(channelId) {
  await ensureBotInChannel(channelId);

  const info = await app.client.conversations.info({ channel: channelId });
  const channelName = info?.channel?.name || "";
  dbg("bot joined channel", { channelId, channelName });

  if (!isReconChannelName(channelName)) {
    dbg("skip (not recon channel)", channelName);
    return;
  }

  // Always invite required users
  const inviteIds = getInviteList();
  await safeConversationsInvite(channelId, inviteIds);

  // If channel name includes deal###
  const dealId = extractDealIdFromChannelName(channelName);
  if (!dealId) {
    dbg("no deal id in channel name", channelName);
    return;
  }

  // Fetch deal → read PM enum → invite PM slack id
  try {
    const deal = await fetchDeal(dealId);
    if (!deal) return;

    const { pmEnumId, pmName, pmFieldKeyUsed } = readPmFromDeal(deal);
    dbg("PM resolved", { dealId, pmEnumId, pmName, pmFieldKeyUsed });

    let pmSlackId = null;

    // Prefer enum-id mapping
    if (pmEnumId != null && PM_ENUM_ID_TO_SLACK[pmEnumId]) {
      pmSlackId = PM_ENUM_ID_TO_SLACK[pmEnumId];
    }

    // If you decide later to map by name, you can add it here
    // (keeping it strict prevents wrong invites)

    if (pmSlackId) {
      await safeConversationsInvite(channelId, [pmSlackId]);
      await app.client.chat.postMessage({
        channel: channelId,
        text: `✅ Recon Assistant invited required users + PM (${pmName || "Project Manager"}).`,
      });
    } else {
      await app.client.chat.postMessage({
        channel: channelId,
        text:
          `✅ Recon Assistant invited required users.\n` +
          `⚠️ PM not auto-invited (no mapping yet). Deal ${dealId}` +
          (pmName ? ` • PM=${pmName}` : "") +
          (pmFieldKeyUsed ? ` • field=${pmFieldKeyUsed}` : ""),
      });
    }
  } catch (e) {
    console.warn("⚠️ PM invite flow failed:", e?.data || e?.message || e);
  }
}

/**
 * NOTE: Slack sends `member_joined_channel` for every user who joins.
 * We only want when the BOT joins.
 */
app.event("member_joined_channel", async ({ event }) => {
  try {
    if (!BOT_USER_ID) return;
    if (event?.user !== BOT_USER_ID) return;
    const channelId = event?.channel;
    if (!channelId) return;

    await handleBotJoinedChannel(channelId);
  } catch (e) {
    console.error("❌ member_joined_channel handler error:", e?.data || e?.message || e);
  }
});

/* =========================
   ✅ REACTION → PD NOTE
   Mirrors your Computron/Catfish pattern, but trimmed.
========================= */
const PD_NOTE_REACTIONS = new Set(["white_check_mark", "heavy_check_mark", "ballot_box_with_check"]);
const noteDedupe = new Map(); // channel:ts -> ms
function recentlyNoted(key, ms = 5 * 60 * 1000) {
  const t = noteDedupe.get(key);
  return t && Date.now() - t < ms;
}

// (optional) file download for attachment upload
async function downloadFile(urlPrivateDownload, botToken) {
  const resp = await axios.get(urlPrivateDownload, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const tmp = path.join(os.tmpdir(), `slack_${Date.now()}_${Math.random().toString(16).slice(2)}.bin`);
  fs.writeFileSync(tmp, resp.data);
  return tmp;
}

async function uploadFileToPipedrive(dealId, filePath, filename) {
  // Minimal: use multipart/form-data via axios
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("deal_id", String(dealId));
  form.append("file", fs.createReadStream(filePath), { filename: filename || "attachment.bin" });

  const url = `https://api.pipedrive.com/v1/files?api_token=${encodeURIComponent(PIPEDRIVE_API_TOKEN)}`;
  const resp = await axios.post(url, form, { headers: form.getHeaders() });
  return resp.data;
}

function buildNoteFromSlack({ channelName, reactorName, authorName, permalink, text, attachmentsList }) {
  const filesLine = attachmentsList?.length ? `\n\nAttachments:\n- ${attachmentsList.join("\n- ")}` : "";
  const linkLine = permalink ? `\n\nSlack link: ${permalink}` : "";
  return (
    `Slack note from #${channelName}\n` +
    `Author: ${authorName}\n` +
    `Approved by: ${reactorName}\n\n` +
    `Message:\n${text || "(no text)"}${filesLine}${linkLine}`
  );
}

app.event("reaction_added", async ({ event, client, context }) => {
  try {
    if (!ENABLE_REACTION_TO_PD_NOTE) return;

    const channelId = event.item?.channel;
    const ts = event.item?.ts;
    if (!channelId || !ts) return;

    if (!PD_NOTE_REACTIONS.has(event.reaction)) return;

    const cacheKey = `${channelId}:${ts}`;
    if (recentlyNoted(cacheKey)) return;

    const ch = await client.conversations.info({ channel: channelId });
    const channelName = ch.channel?.name || "";
    const dealId = extractDealIdFromChannelName(channelName);

    if (!dealId) {
      await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `⚠️ Channel name must include “deal###”.` });
      return;
    }

    // Fetch message
    const hist = await client.conversations.history({ channel: channelId, latest: ts, inclusive: true, limit: 1 });
    const msg = hist.messages?.[0];
    if (!msg) return;

    const [authorInfo, reactorInfo, linkRes] = await Promise.all([
      msg.user ? client.users.info({ user: msg.user }).catch(() => null) : null,
      client.users.info({ user: event.user }).catch(() => null),
      client.chat.getPermalink({ channel: channelId, message_ts: ts }).catch(() => null),
    ]);

    const authorName =
      authorInfo?.user?.real_name ||
      authorInfo?.user?.profile?.display_name ||
      (msg.user ? `<@${msg.user}>` : "unknown");

    const reactorName =
      reactorInfo?.user?.real_name ||
      reactorInfo?.user?.profile?.display_name ||
      `<@${event.user}>`;

    const permalink = linkRes?.permalink;

    // Handle attachments
    const attachmentsList = [];
    if (Array.isArray(msg.files) && msg.files.length) {
      for (const f of msg.files) attachmentsList.push(`${f.name} (${f.filetype})`);

      if (REACTION_UPLOAD_FILES) {
        for (const f of msg.files) {
          try {
            const tmp = await downloadFile(f.url_private_download, context.botToken);
            await uploadFileToPipedrive(dealId, tmp, f.name);
            try { fs.unlinkSync(tmp); } catch {}
          } catch (e) {
            console.warn("⚠️ attachment upload failed:", f.name, e?.message || e);
          }
        }
      }
    }

    const content = buildNoteFromSlack({
      channelName,
      reactorName,
      authorName,
      permalink,
      text: msg.text || "",
      attachmentsList,
    });

    const noteRes = await pdPost("notes", { deal_id: Number(dealId), content });
    if (noteRes?.success) {
      noteDedupe.set(cacheKey, Date.now());
      await client.reactions.add({ channel: channelId, name: "white_check_mark", timestamp: ts }).catch(() => {});
      await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `✅ Sent to Pipedrive deal *${dealId}*.` });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `⚠️ Failed to send to Pipedrive.` });
    }
  } catch (err) {
    console.error("❌ reaction_added handler error:", err?.data || err?.message || err);
  }
});

/* =========================
   Start
========================= */
(async () => {
  await initBotIdentity();
  await app.start(); // Socket Mode ignores PORT for receiving events; web server handles health checks
  console.log("✅ Recon Assistant running (Socket Mode).");
})();
