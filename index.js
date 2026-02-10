// index.js (ESM) — Recon Assistant (Socket Mode)
// Features:
//  - When bot joins a recon channel (name contains "rcn"), invite required users
//  - Reaction ✅ on a message posts that message to the Pipedrive deal as a note
//  - Deal inferred from channel name "deal###"

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";

// IMPORTANT: Slack Bolt is CommonJS, so import default pkg
import boltPkg from "@slack/bolt";
const { App } = boltPkg;

/* =========================
   ENV
========================= */
const PORT = Number(process.env.PORT || 8080);

// Slack
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN; // xapp-...
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // xoxb-...
const SLACK_SIGNING_SECRET =
  process.env.SLACK_SIGNING_SECRET || "unused_in_socket_mode";

// Pipedrive
const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

// Toggles
const ENABLE_REACTION_TO_PD_NOTE =
  (process.env.ENABLE_REACTION_TO_PD_NOTE || "true") !== "false";

const REACTION_UPLOAD_FILES =
  (process.env.REACTION_UPLOAD_FILES || "false") === "true";

// Recon channel detection
const RECON_CHANNEL_REGEX = new RegExp(
  process.env.RECON_CHANNEL_REGEX || "rcn",
  "i"
);

// Optional PM field key if you want later
const PM_FIELD_KEY = process.env.PM_FIELD_KEY || "";

/* =========================
   ALWAYS INVITE USERS
========================= */
const ALWAYS_INVITE_USER_IDS = [
  "U09PUG47MAM", // Ariel
  "U05G8MQ54JD", // Ryan
  "U086RE5K3LY", // Lamar
];

// Add optional others here later
const CORE_INVITE_USER_IDS = [
  // "U07AB7A4UNS", // Anastacio
  // "U0A7S1K86CX", // Lana
  // "U05FYG3EMHS", // Kim
  // "U06DKJ1BJ9W", // Danica
  // "U05FPCPHJG6", // Mike
].filter(Boolean);

function getInviteList() {
  return Array.from(
    new Set([...ALWAYS_INVITE_USER_IDS, ...CORE_INVITE_USER_IDS])
  );
}

/* =========================
   DEBUG
========================= */
const DEBUG = (process.env.DEBUG || "false") === "true";
const dbg = (...args) => DEBUG && console.log("[DBG]", ...args);

/* =========================
   Slack App (Socket Mode)
========================= */
if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) {
  console.error(
    "❌ Missing SLACK_APP_TOKEN (xapp-...) or SLACK_BOT_TOKEN (xoxb-...). Set Railway Variables."
  );
  process.exit(1);
}

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
});

/* =========================
   Health server for Railway
========================= */
const web = express();

web.get("/", (_req, res) => res.status(200).send("Recon Assistant OK"));
web.get("/healthz", (_req, res) => res.status(200).send("ok"));

web.listen(PORT, () => console.log(`🌐 Health server on :${PORT}`));

/* =========================
   Helpers
========================= */
function extractDealIdFromChannelName(channelName = "") {
  const m = String(channelName).match(/deal(\d+)/i);
  return m ? m[1] : null;
}

function isReconChannelName(channelName = "") {
  return RECON_CHANNEL_REGEX.test(channelName);
}

async function safeConversationsInvite(channel, userIds = []) {
  if (!channel || !userIds.length) return;

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
      dbg("invite error", e?.data || e?.message || e);
    }
  }
}

async function ensureBotInChannel(channelId) {
  if (!channelId) return;
  try {
    await app.client.conversations.join({ channel: channelId });
  } catch (e) {
    // ignore
  }
}

/* =========================
   Pipedrive Helpers
========================= */
async function pdPost(url, payload) {
  if (!PIPEDRIVE_API_TOKEN) throw new Error("Missing PIPEDRIVE_API_TOKEN");

  const full = `https://api.pipedrive.com/v1/${url}?api_token=${encodeURIComponent(
    PIPEDRIVE_API_TOKEN
  )}`;

  const r = await axios.post(full, payload, {
    headers: { "Content-Type": "application/json" },
  });

  return r.data;
}

/* =========================
   Slack Note Formatting
========================= */
function cleanSlackText(s = "") {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDateTime(dt = new Date()) {
  return dt.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildNoteFromSlack({
  channelName,
  reactorName,
  authorName,
  permalink,
  text,
  attachmentsList,
}) {
  const message = cleanSlackText(text || "");

  const attachmentsBlock =
    attachmentsList?.length
      ? `\nAttachments:\n- ${attachmentsList.join("\n- ")}`
      : "";

  const linkBlock = permalink ? `\nSlack Link: ${permalink}` : "";

  return `✅ Slack Approval (Recon)

Channel: #${channelName}
Author: ${authorName}
Approved By: ${reactorName}
Date: ${formatDateTime(new Date())}

Message:
${message || "(no text)"}${attachmentsBlock}${linkBlock}`;
}

/* =========================
   Attachment Download / Upload (Optional)
========================= */
async function downloadFile(urlPrivateDownload, botToken) {
  const resp = await axios.get(urlPrivateDownload, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${botToken}` },
  });

  const tmp = path.join(
    os.tmpdir(),
    `slack_${Date.now()}_${Math.random().toString(16).slice(2)}.bin`
  );

  fs.writeFileSync(tmp, resp.data);
  return tmp;
}

async function uploadFileToPipedrive(dealId, filePath, filename) {
  const FormData = (await import("form-data")).default;

  const form = new FormData();
  form.append("deal_id", String(dealId));
  form.append("file", fs.createReadStream(filePath), {
    filename: filename || "attachment.bin",
  });

  const url = `https://api.pipedrive.com/v1/files?api_token=${encodeURIComponent(
    PIPEDRIVE_API_TOKEN
  )}`;

  const resp = await axios.post(url, form, {
    headers: form.getHeaders(),
  });

  return resp.data;
}

/* =========================
   BOT JOINED CHANNEL → INVITE USERS
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

  const inviteIds = getInviteList();
  await safeConversationsInvite(channelId, inviteIds);

  await app.client.chat.postMessage({
    channel: channelId,
    text: `✅ Recon Assistant invited required users.`,
  });
}

app.event("member_joined_channel", async ({ event }) => {
  try {
    if (!BOT_USER_ID) return;
    if (event?.user !== BOT_USER_ID) return;

    const channelId = event?.channel;
    if (!channelId) return;

    await handleBotJoinedChannel(channelId);
  } catch (e) {
    console.error(
      "❌ member_joined_channel handler error:",
      e?.data || e?.message || e
    );
  }
});

/* =========================
   ✅ REACTION → PD NOTE
========================= */
const PD_NOTE_REACTIONS = new Set([
  "white_check_mark",
  "heavy_check_mark",
  "ballot_box_with_check",
]);

const noteDedupe = new Map();
function recentlyNoted(key, ms = 5 * 60 * 1000) {
  const t = noteDedupe.get(key);
  return t && Date.now() - t < ms;
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
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text: `⚠️ Channel name must include “deal###”.`,
      });
      return;
    }

    const hist = await client.conversations.history({
      channel: channelId,
      latest: ts,
      inclusive: true,
      limit: 1,
    });

    const msg = hist.messages?.[0];
    if (!msg) return;

    const [authorInfo, reactorInfo, linkRes] = await Promise.all([
      msg.user ? client.users.info({ user: msg.user }).catch(() => null) : null,
      client.users.info({ user: event.user }).catch(() => null),
      client.chat.getPermalink({ channel: channelId, message_ts: ts }).catch(() => null),
    ]);

    const authorName =
      authorInfo?.user?.profile?.real_name_normalized ||
      authorInfo?.user?.real_name ||
      authorInfo?.user?.profile?.display_name ||
      authorInfo?.user?.name ||
      (msg.user ? `User ${msg.user}` : "Unknown");

    const reactorName =
      reactorInfo?.user?.profile?.real_name_normalized ||
      reactorInfo?.user?.real_name ||
      reactorInfo?.user?.profile?.display_name ||
      reactorInfo?.user?.name ||
      `User ${event.user}`;

    const permalink = linkRes?.permalink;

    const attachmentsList = [];
    if (Array.isArray(msg.files) && msg.files.length) {
      for (const f of msg.files) {
        attachmentsList.push(`${f.name} (${f.filetype})`);
      }

      if (REACTION_UPLOAD_FILES) {
        for (const f of msg.files) {
          try {
            const tmp = await downloadFile(
              f.url_private_download,
              context.botToken
            );
            await uploadFileToPipedrive(dealId, tmp, f.name);

            try {
              fs.unlinkSync(tmp);
            } catch {}
          } catch (e) {
            console.warn(
              "⚠️ attachment upload failed:",
              f.name,
              e?.message || e
            );
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

    const noteRes = await pdPost("notes", {
      deal_id: Number(dealId),
      content,
    });

    if (noteRes?.success) {
      noteDedupe.set(cacheKey, Date.now());

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text: `✅ Sent to Pipedrive deal *${dealId}*.`,
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text: `⚠️ Failed to send to Pipedrive.`,
      });
    }
  } catch (err) {
    console.error(
      "❌ reaction_added handler error:",
      err?.data || err?.message || err
    );
  }
});

/* =========================
   Start
========================= */
(async () => {
  await initBotIdentity();
  await app.start();
  console.log("✅ Recon Assistant running (Socket Mode).");
})();
