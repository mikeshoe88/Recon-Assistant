// index.js (ESM) — Computron Recon core (auto-start + auto-invite + PD Slack URL writeback)
//
// ✅ What this does (core-only):
// 1) When Computron BOT joins a recon channel named like: rcn-<anything>-deal###
//    - invites Ariel + Ryan + Lamar (always)
//    - (optional) invites the PM based on the Pipedrive "Project Manager" custom field value
//    - writes the Slack channel permalink into the Pipedrive "Slack URL" deal custom field
//    - posts a short “Recon started” message in the channel
//
// --------------------
// REQUIRED ENV VARS (Railway Variables)
// --------------------
// SLACK_APP_TOKEN= xapp-...
// SLACK_BOT_TOKEN= xoxb-...
// SLACK_SIGNING_SECRET= (not used in socket mode, but safe to include)
// PIPEDRIVE_API_TOKEN= ...
// BASE_URL= https://<your-railway-app>.up.railway.app  (optional; only for health/info)
//
// --------------------
// Pipedrive field keys (from your payload)
// --------------------
// Project Manager field key: 98c305112b26675e9b22748fae8cb7a274e4d8e7
// Slack URL field key:       0cc683d3e270d0676aa9d00e38f6a96179de7fc2
//
// NOTE: Do NOT hardcode tokens in code. Put them in Railway Variables.

import dotenv from "dotenv";
dotenv.config();

import bolt from "@slack/bolt";
const { App } = bolt;

import fetch from "node-fetch";

/* =========================
   ENV / CONSTANTS
========================= */
const PORT = process.env.PORT || 3000;

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;   // xapp-...
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;   // xoxb-...
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "unused_in_socket_mode";

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Pipedrive custom field keys (from your deal fields payload)
const PD_PROJECT_MANAGER_FIELD_KEY =
  process.env.PD_PROJECT_MANAGER_FIELD_KEY || "98c305112b26675e9b22748fae8cb7a274e4d8e7";

const PD_SLACK_URL_FIELD_KEY =
  process.env.PD_SLACK_URL_FIELD_KEY || "0cc683d3e270d0676aa9d00e38f6a96179de7fc2";

// Always invite these 3 to EVERY recon channel (your instruction)
const ALWAYS_INVITE_RECON_USER_IDS = [
  "U09PUG47MAM", // Ariel
  "U05G8MQ54JD", // Ryan
  "U086RE5K3LY", // Lamar
];

// Project Manager enum option IDs -> Slack user IDs
// From your Project Manager field "options":
// 62 Ryan, 63 Shoemaker, 64 PM1, ... 71 PM8
//
// Fill in the Slack IDs as you learn them.
const RECON_PM_ENUM_TO_SLACK = {
  62: "U05G8MQ54JD", // Ryan
  63: "U05FPCPHJG6", // Shoemaker (Mike)  <-- adjust if you want a different Slack user id
  // 64: "UXXXXXXXXXXX", // PM1
  // 65: "UXXXXXXXXXXX", // PM2
  // ...
};

/* =========================
   Slack App (Socket Mode)
========================= */
if (!SLACK_APP_TOKEN) throw new Error("Missing SLACK_APP_TOKEN (xapp-...)");
if (!SLACK_BOT_TOKEN) throw new Error("Missing SLACK_BOT_TOKEN (xoxb-...)");
if (!PIPEDRIVE_API_TOKEN) throw new Error("Missing PIPEDRIVE_API_TOKEN");

const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: SLACK_APP_TOKEN,
});

/* =========================
   Helpers
========================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isReconChannelName(name = "") {
  return String(name).toLowerCase().startsWith("rcn-");
}

// expects deal### somewhere in the channel name
function extractDealIdFromChannelName(name = "") {
  const m = String(name).toLowerCase().match(/deal(\d+)\b/);
  return m ? m[1] : null;
}

// Invite users; ignore common invite errors (already_in_channel, cant_invite_self, etc.)
async function inviteUsersToChannel(client, channelId, userIds = []) {
  const users = [...new Set(userIds.filter(Boolean))];
  if (!channelId || !users.length) return;

  try {
    await client.conversations.invite({
      channel: channelId,
      users: users.join(","),
    });
  } catch (e) {
    const err = e?.data?.error || e?.message || String(e);
    // benign cases
    if (
      err.includes("already_in_channel") ||
      err.includes("cant_invite_self") ||
      err.includes("not_in_channel") ||
      err.includes("not_supported") ||
      err.includes("failed_for_some_users")
    ) {
      console.log("[inviteUsersToChannel] non-fatal:", err);
      return;
    }
    console.log("[inviteUsersToChannel] error:", err);
  }
}

// Ensure bot is in channel (join)
async function ensureBotInChannel(client, channelId) {
  try {
    await client.conversations.join({ channel: channelId });
  } catch (e) {
    // ignore (private channels, already_in_channel, etc.)
  }
}

/* =========================
   Pipedrive helpers
========================= */
async function pdGetDeal(dealId) {
  const url = `https://api.pipedrive.com/v1/deals/${encodeURIComponent(
    dealId
  )}?return_field_key=1&api_token=${encodeURIComponent(PIPEDRIVE_API_TOKEN)}`;

  const resp = await fetch(url);
  const json = await resp.json();
  if (!json?.success) throw new Error(`PD deal fetch failed: ${JSON.stringify(json)}`);
  return json.data;
}

async function pdUpdateDeal(dealId, payload) {
  const url = `https://api.pipedrive.com/v1/deals/${encodeURIComponent(
    dealId
  )}?api_token=${encodeURIComponent(PIPEDRIVE_API_TOKEN)}`;

  const resp = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await resp.json();
  if (!json?.success) throw new Error(`PD deal update failed: ${JSON.stringify(json)}`);
  return json.data;
}

/* =========================
   Recon “start” workflow
========================= */
async function startReconChannel({ client, channelId, channelName }) {
  const dealId = extractDealIdFromChannelName(channelName);
  if (!dealId) {
    await client.chat.postMessage({
      channel: channelId,
      text: "⚠️ Recon channel name must include `deal###` (example: `rcn-smith-deal603`).",
    });
    return;
  }

  // Always invite baseline recon users
  await ensureBotInChannel(client, channelId);
  await sleep(250);
  await inviteUsersToChannel(client, channelId, ALWAYS_INVITE_RECON_USER_IDS);

  // Pull deal, detect PM enum, invite PM (optional)
  let deal = null;
  let pmSlack = null;
  try {
    deal = await pdGetDeal(dealId);

    const pmVal = deal?.[PD_PROJECT_MANAGER_FIELD_KEY];
    // enum field may come as number, string, or object with .value
    const pmEnumId =
      (pmVal && typeof pmVal === "object" && pmVal.value != null)
        ? Number(pmVal.value)
        : (pmVal != null ? Number(pmVal) : null);

    if (pmEnumId && RECON_PM_ENUM_TO_SLACK[pmEnumId]) {
      pmSlack = RECON_PM_ENUM_TO_SLACK[pmEnumId];
      await inviteUsersToChannel(client, channelId, [pmSlack]);
    }
  } catch (e) {
    console.log("[startReconChannel] PD fetch/invite PM failed:", e?.message || e);
  }

  // Write Slack URL back to Pipedrive (Slack URL field)
  try {
    const link = await client.chat.getPermalink({
      channel: channelId,
      message_ts: (await client.chat.postMessage({
        channel: channelId,
        text: `✅ Recon channel initialized for deal *${dealId}*.`,
      }))?.ts,
    });

    const permalink = link?.permalink || null;
    if (permalink) {
      await pdUpdateDeal(dealId, { [PD_SLACK_URL_FIELD_KEY]: permalink });
    }
  } catch (e) {
    console.log("[startReconChannel] PD Slack URL writeback failed:", e?.message || e);
  }

  // Final message (clean + quick)
  const baselineMentions = ALWAYS_INVITE_RECON_USER_IDS.map((id) => `<@${id}>`).join(" ");
  const pmLine = pmSlack ? `PM invited: <@${pmSlack}>` : "PM invite: (not set / not mapped yet)";
  await client.chat.postMessage({
    channel: channelId,
    text:
      `🧱 *Recon started*\n` +
      `• Deal: *${dealId}*\n` +
      `• Baseline: ${baselineMentions}\n` +
      `• ${pmLine}\n` +
      `• Channel format: \`rcn-<name>-deal${dealId}\``,
  });
}

/* =========================
   Events
========================= */

// This fires when *any* user joins a channel.
// We only run when the joining user is the BOT itself (Computron).
app.event("member_joined_channel", async ({ event, client, context }) => {
  try {
    const channelId = event.channel;
    const joiningUser = event.user;

    // Only trigger when the bot user joins (prevents noise)
    if (!context?.botUserId || joiningUser !== context.botUserId) return;

    const info = await client.conversations.info({ channel: channelId });
    const channelName = info?.channel?.name || "";

    if (!isReconChannelName(channelName)) return;

    console.log(`[ReconAutoStart] bot joined #${channelName} (${channelId})`);
    await startReconChannel({ client, channelId, channelName });
  } catch (e) {
    console.log("[member_joined_channel] error:", e?.data?.error || e?.message || e);
  }
});

// Optional: manual command to re-run on demand
app.command("/recon-start", async ({ ack, body, client }) => {
  await ack();
  try {
    const channelId = body.channel_id;
    const info = await client.conversations.info({ channel: channelId });
    const channelName = info?.channel?.name || "";

    if (!isReconChannelName(channelName)) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user_id,
        text: "⚠️ This command only works in `rcn-...` channels.",
      });
      return;
    }

    await startReconChannel({ client, channelId, channelName });
  } catch (e) {
    console.log("[/recon-start] error:", e?.data?.error || e?.message || e);
  }
});

/* =========================
   Tiny health server (Railway)
========================= */
import express from "express";
const web = express();

web.get("/", (_req, res) => res.status(200).send("Computron Recon OK"));
web.get("/healthz", (_req, res) => res.status(200).send("ok"));

web.listen(PORT, () => {
  console.log(`🌐 Web listening on ${PORT} (${BASE_URL})`);
});

/* =========================
   Start Slack app
========================= */
(async () => {
  await app.start(); // socket mode doesn't need a port here
  console.log("✅ Computron Recon (Socket Mode) is running");
})();

