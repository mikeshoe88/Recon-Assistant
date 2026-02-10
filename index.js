// index.js (ESM) — Recon Assistant (Socket Mode)
// Features:
//  - When bot joins a recon channel (name contains "rcn"), invite required users
//  - Reaction ✅ on a message posts that message to the Pipedrive deal as a note
//  - Deal inferred from channel name "deal###"
//  - (Optional) Re-upload Slack-attached files into the channel/thread as true Slack documents
//
// IMPORTANT NOTES:
//  1) To resolve Slack user IDs into human names, the app MUST have OAuth scope: users:read
//     and you MUST reinstall the app after adding scopes.
//  2) To upload files, the app MUST have: files:write and you MUST reinstall the app.
//
// ENV toggles:
//  ENABLE_REACTION_TO_PD_NOTE=true|false
//  REACTION_UPLOAD_FILES=true|false            -> uploads attachments to Pipedrive
//  REACTION_REPOST_FILES_TO_SLACK=true|false   -> re-uploads attachments back to Slack as files (documents)
//  REPOST_FILES_TARGET=thread|channel          -> upload into thread (default) or channel root
//  RECON_CHANNEL_REGEX=rcn                     -> recon channel detection

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

const REACTION_REPOST_FILES_TO_SLACK =
  (process.env.REACTION_REPOST_FILES_TO_SLACK || "false") === "true";

const REPOST_FILES_TARGET = (process.env.REPOST_FILES_TARGET || "thread").toLowerCase();

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
  } catch {
    // ignore
  }
}

/* =========================
   Slack identity helpers (IDs -> names)
========================= */
const userNameCache = new Map();

async function slackUserIdToName(client, userId) {
  if (!userId) return "Unknown";
  if (userNameCache.has(userId)) return userNameCache.get(userId);

  try {
    const r = await client.users.info({ user: userId });
    if (!r?.ok) {
      userNameCache.set(userId, `User ${userId}`);
      return `User ${userId}`;
    }

    const u = r.user;
    const p = u?.profile;
    const name =
      p?.real_name_normalized ||
      u?.real_name ||
      p?.display_name ||
      u?.name ||
      `User ${userId}`;

    userNameCache.set(userId, name);
    return name;
  } catch (e) {
    // Most common cause: missing_scope (users:read)
    const fallback = `User ${userId}`;
    userNameCache.set(userId, fallback);
    return fallback;
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
   Attachment Download / Upload
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

// Re-upload a file to Slack as a true document (not a link)
async function uploadFileToSlack({ botToken, channelId, threadTs, filePath, filename, title }) {
  const FormData = (await import("form-data")).default;

  const form = new FormData();
  form.append("channels", channelId);
  form.append("file", fs.createReadStream(filePath), {
    filename: filename || path.basename(filePath),
    contentType: "application/octet-stream",
  });
  if (title) form.append("title", title);

  // Upload into thread if requested
  if (threadTs && REPOST_FILES_TARGET === "thread") {
    form.append("thread_ts", threadTs);
  }

  // optional comment
  form.append("initial_comment", "📎 File uploaded by Recon Assistant");

  const resp = await axios.post("https://slack.com/api/files.upload", form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${botToken}`,
    },
  });

  const data = resp.data;
  if (!data?.ok) {
    throw new Error(`Slack files.upload failed: ${data?.error || "unknown_error"}`);
  }

  return data;
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
   ✅ REACTION → PD NOTE (+ optional file handling)
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

    // Resolve human-readable names (requires users:read)
    const [authorName, reactorName, linkRes] = await Promise.all([
      msg.user ? slackUserIdToName(client, msg.user) : Promise.resolve("Unknown"),
      slackUserIdToName(client, event.user),
      client.chat.getPermalink({ channel: channelId, message_ts: ts }).catch(() => null),
    ]);

    const permalink = linkRes?.permalink;

    const attachmentsList = [];

    // Files on the original message
    if (Array.isArray(msg.files) && msg.files.length) {
      for (const f of msg.files) {
        attachmentsList.push(`${f.name} (${f.filetype})`);
      }

      // Optional: upload to Pipedrive
      if (REACTION_UPLOAD_FILES) {
        for (const f of msg.files) {
          try {
            if (!f?.url_private_download) continue;
            const tmp = await downloadFile(f.url_private_download, context.botToken);
            await uploadFileToPipedrive(dealId, tmp, f.name);
            try { fs.unlinkSync(tmp); } catch {}
          } catch (e) {
            console.warn("⚠️ attachment upload to Pipedrive failed:", f?.name, e?.message || e);
          }
        }
      }

      // Optional: Re-upload to Slack as real file(s)
      // Useful when you want the bot to "send" the PDF as a document (instead of posting only a link)
      if (REACTION_REPOST_FILES_TO_SLACK) {
        // Make sure the bot is in the channel (public channels)
        await ensureBotInChannel(channelId);

        for (const f of msg.files) {
          try {
            if (!f?.url_private_download) continue;
            const tmp = await downloadFile(f.url_private_download, context.botToken);

            await uploadFileToSlack({
              botToken: context.botToken,
              channelId,
              threadTs: ts,
              filePath: tmp,
              filename: f.name,
              title: f.title || f.name,
            });

            try { fs.unlinkSync(tmp); } catch {}
          } catch (e) {
            console.warn("⚠️ re-upload to Slack failed:", f?.name, e?.message || e);
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
    console.error("❌ reaction_added handler error:", err?.data || err?.message || err);
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
