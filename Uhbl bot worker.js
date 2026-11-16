 // UHBL win bot - Cloudflare Worker (module syntax)
//
// Routes
//   POST /win           Roblox -> Worker. Posts the "possible win" message through the bot with Confirm / Reject buttons.
//   POST /interactions  Discord -> Worker. Handles button clicks. Only OWNER_ID may use them.
//
// Secrets / variables to add in Cloudflare (Worker > Settings > Variables and Secrets):
//   DISCORD_PUBLIC_KEY   8d23610bab5e71cf1c4fff0bf7e513436a53650d541f926525b4777cf9ad0e3e
//   DISCORD_BOT_TOKEN    MTU3MTgzNTY0ODg1MDAwNjA3OQ.GxUucG.oG_zIw479wf5jerQvohNUSbhu2Dh87HKF44i9Y
//   CHANNEL_ID           1329789700600365099
//   OWNER_ID             968926117023088743
//   SHARED_SECRET        Any long random string (the same one goes in the Roblox script)
// Optional (only if you want the decision sent back into the game):
//   ROBLOX_API_KEY       Open Cloud key with Messaging Service "publish" permission
//   UNIVERSE_ID          10766685268

const TOPIC = "UHBL_WinDecision";
const GREEN = 0x2ecc71;
const RED = 0xe74c3c;

const json = (data, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const ephemeral = (text) => json({ type: 4, data: { content: text, flags: 64 } });

function hexToBytes(hex) {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

async function verifyDiscord(request, rawBody, env) {
	const signature = request.headers.get("X-Signature-Ed25519");
	const timestamp = request.headers.get("X-Signature-Timestamp");
	if (!signature || !timestamp) return false;

	const data = new TextEncoder().encode(timestamp + rawBody);
	const algorithms = [{ name: "Ed25519" }, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }];

	for (const algorithm of algorithms) {
		try {
			const key = await crypto.subtle.importKey("raw", hexToBytes(env.DISCORD_PUBLIC_KEY), algorithm, false, ["verify"]);
			return await crypto.subtle.verify(algorithm.name, key, hexToBytes(signature), data);
		} catch (err) {
			// try the next algorithm name
		}
	}
	return false;
}

async function notifyRoblox(env, winId, decision, discordUserId) {
	if (!env.ROBLOX_API_KEY || !env.UNIVERSE_ID) return;
	try {
		await fetch(`https://apis.roblox.com/messaging-service/v1/universes/${env.UNIVERSE_ID}/topics/${TOPIC}`, {
			method: "POST",
			headers: { "x-api-key": env.ROBLOX_API_KEY, "Content-Type": "application/json" },
			body: JSON.stringify({ message: JSON.stringify({ WinId: winId, Decision: decision, DiscordUserId: discordUserId }) }),
		});
	} catch (err) {
		// the Discord message is already updated; ignore failures talking to Roblox
	}
}

async function handleWin(request, env) {
	if (request.headers.get("x-secret") !== env.SHARED_SECRET) {
		return json({ error: "unauthorized" }, 401);
	}

	const body = await request.json();
	const winId = String(body.winId || "");
	if (!winId || !Array.isArray(body.embeds)) {
		return json({ error: "bad request" }, 400);
	}

	const payload = {
		content: body.content || "possible win",
		embeds: body.embeds,
		allowed_mentions: { users: [env.OWNER_ID] },
		components: [
			{
				type: 1,
				components: [
					{ type: 2, style: 3, label: "Confirm", custom_id: `uhbl_confirm:${winId}` },
					{ type: 2, style: 4, label: "Reject", custom_id: `uhbl_reject:${winId}` },
				],
			},
		],
	};

	const response = await fetch(`https://discord.com/api/v10/channels/${env.CHANNEL_ID}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "DiscordBot (uhbl-win-bot, 1.0)",
		},
		body: JSON.stringify(payload),
	});

	return new Response(await response.text(), {
		status: response.status,
		headers: { "Content-Type": "application/json" },
	});
}

async function handleInteraction(request, env, ctx) {
	const rawBody = await request.text();
	if (!(await verifyDiscord(request, rawBody, env))) {
		return new Response("invalid request signature", { status: 401 });
	}

	const interaction = JSON.parse(rawBody);

	// Discord's endpoint check
	if (interaction.type === 1) {
		return json({ type: 1 });
	}

	// button click
	if (interaction.type === 3) {
		const userId = interaction.member?.user?.id ?? interaction.user?.id;
		const customId = interaction.data?.custom_id ?? "";
		const split = customId.indexOf(":");
		const action = split === -1 ? customId : customId.slice(0, split);
		const winId = split === -1 ? "" : customId.slice(split + 1);

		const confirmed = action === "uhbl_confirm";
		if (!confirmed && action !== "uhbl_reject") {
			return ephemeral("Unknown button.");
		}
		if (userId !== env.OWNER_ID) {
			return ephemeral("Only the owner can use these buttons.");
		}

		const embed = (interaction.message?.embeds ?? [])[0];
		if (!embed) {
			return ephemeral("That message has no embed to update.");
		}

		embed.color = confirmed ? GREEN : RED;
		embed.title = (confirmed ? "Confirmed win: " : "Rejected win: ") + String(embed.title || "").replace(/^[^:]*:\s*/, "");
		embed.fields = (embed.fields ?? []).map((field) =>
			field.name === "Status"
				? { ...field, value: `${confirmed ? "Confirmed" : "Rejected"} by <@${userId}>` }
				: field
		);

		ctx.waitUntil(notifyRoblox(env, winId, confirmed ? "confirm" : "reject", userId));

		// type 7 = update the message the button was on; empty components removes the buttons
		return json({
			type: 7,
			data: {
				content: confirmed ? "Win confirmed" : "Win rejected",
				embeds: [embed],
				components: [],
				allowed_mentions: { parse: [] },
			},
		});
	}

	return json({ type: 1 });
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/win") {
			return handleWin(request, env);
		}
		if (request.method === "POST" && url.pathname === "/interactions") {
			return handleInteraction(request, env, ctx);
		}
		return new Response("UHBL win bot", { status: 200 });
	},
};
