window.__ModuleLoader__.load({
	id: "dsh-onebot-connector",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const API = "/onebot-connector/api";
		const NS = "settings.onebotConnector";

		const zh = {
			title: "OneBot 连接",
			desc: "把 OneBot v11 接进 DSH。QQ 账号登录由 OneBot 实现自己负责，这里只配连接地址。",
			connTitle: "连接",
			connHint: "填 OneBot 实现（NapCat / LLOneBot / Lagrange / go-cqhttp）的正向 WebSocket 地址。",
			fBaseUrl: "WebSocket 地址",
			fBaseUrlHint: "例如 ws://127.0.0.1:3001",
			fToken: "access_token",
			fTokenHint: "没设就留空。只保存在本机，不会回显。",
			connect: "连接", disconnect: "断开",
			online: "在线", offline: "离线", connecting: "连接中",
			fEnabled: "启用连接",
			fEnabledHint: "与 DSH 生命周期一致：启用即连接，禁用或退出 DSH 即断开。",
			groupsTitle: "群列表",
			groupsHint: "勾选 = 被动监听（收到消息就推送）。其它群只缓存，模型要主动读才知道。",
			groupsEmpty: "（连接后显示）",
			refresh: "刷新",
			targetTitle: "推送目标",
			targetHint: "选一个会话当「我家的鱼」。",
			targetNone: "（不推送）",
			permTitle: "权限",
			permSend: "允许主动发消息",
			permSticker: "允许发表情包",
			permRead: "允许主动读取群",
			save: "保存", saving: "保存中…",
			loading: "加载中…",
		};

		const en = {
			title: "OneBot connection",
			desc: "Bridge OneBot v11 into DSH. QQ login is handled by the OneBot implementation; only the endpoint is configured here.",
			connTitle: "Connection",
			connHint: "Forward WebSocket URL of your OneBot implementation (NapCat / LLOneBot / Lagrange / go-cqhttp).",
			fBaseUrl: "WebSocket URL",
			fBaseUrlHint: "e.g. ws://127.0.0.1:3001",
			fToken: "access_token",
			fTokenHint: "Leave blank if unset. Stored locally, never echoed.",
			connect: "Connect", disconnect: "Disconnect",
			online: "Online", offline: "Offline", connecting: "Connecting",
			fEnabled: "Enable connection",
			fEnabledHint: "Tied to the DSH lifecycle: enabling connects, disabling or quitting DSH disconnects.",
			groupsTitle: "Groups",
			groupsHint: "Checked = passive listening. Others are cached only.",
			groupsEmpty: "(after connecting)",
			refresh: "Refresh",
			targetTitle: "Push target",
			targetHint: "Pick the session acting as your fish.",
			targetNone: "(do not push)",
			permTitle: "Permissions",
			permSend: "Allow sending",
			permSticker: "Allow stickers",
			permRead: "Allow active reading",
			save: "Save", saving: "Saving…",
			loading: "Loading…",
		};

		const S = {
			wrap: { display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0" },
			h1: { fontSize: "17px", fontWeight: 600, margin: 0 },
			h2: { fontSize: "13px", fontWeight: 600, margin: 0 },
			sub: { fontSize: "12px", opacity: 0.65, lineHeight: 1.5, margin: 0 },
			box: { border: "1px solid rgba(128,128,128,.25)", borderRadius: "8px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px" },
			row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			btn: { padding: "4px 10px", fontSize: "12px", cursor: "pointer", borderRadius: "6px", border: "1px solid rgba(128,128,128,.35)", background: "transparent", color: "inherit" },
			primary: { padding: "5px 14px", fontSize: "12px", cursor: "pointer", borderRadius: "6px", border: "1px solid #4d6bfe", background: "#4d6bfe", color: "#fff" },
			input: { padding: "6px 8px", fontSize: "13px", borderRadius: "6px", border: "1px solid rgba(128,128,128,.35)", background: "transparent", color: "inherit", width: "100%", boxSizing: "border-box" },
			mono: { fontFamily: "ui-monospace,monospace", fontSize: "11px", opacity: 0.7, wordBreak: "break-all" },
			dot: (on) => ({ width: "8px", height: "8px", borderRadius: "50%", background: on ? "#3ba55c" : "#8a8a8a", flex: "0 0 auto" }),
		};

		function Field(props) {
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "3px" } },
				h("span", { style: { fontSize: "12px", opacity: 0.75 } }, props.label),
				props.children,
				props.hint ? h("span", { style: { fontSize: "11px", opacity: 0.5 } }, props.hint) : null);
		}
		function field(props, child) {
			return h(Field, Object.assign({}, props, { children: child }));
		}

		function Card(props) {
			const t = props.t || ((k) => k);
			const useCard = props.useOnebotCard || props.useOneBotCard;
			const state = (typeof useCard === "function" ? useCard((s) => s) : null) || {};
			const fieldOf = (k) => state[k] || (state.fields || {})[k];
			const ftext = (k) => {
				const f = fieldOf(k);
				return (f && (typeof f.text === "string" ? f.text : f.value)) || "";
			};
			const isOn = (k) => String(ftext(k)).trim().toLowerCase() === "true";

			const [data, setData] = React.useState(null);
			const [msg, setMsg] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [baseUrl, setBaseUrl] = React.useState("");
			const [token, setToken] = React.useState("");

			const load = React.useCallback(() => {
				fetch(API + "/state", { cache: "no-store" })
					.then((x) => x.json())
					.then((r) => { if (r.ok) setData(r); })
					.catch((e) => setMsg(String(e && e.message ? e.message : e)));
			}, []);

			React.useEffect(() => {
				load();
				const tm = setInterval(load, 3000);
				return () => clearInterval(tm);
			}, [load]);

			const post = React.useCallback((path, body) => {
				setBusy(true); setMsg("");
				return fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
					.then((x) => x.json())
					.then((r) => { load(); return r; })
					.catch((e) => { setMsg(String(e && e.message ? e.message : e)); return { ok: false }; })
					.finally(() => setBusy(false));
			}, [load]);

			if (!data) return h("div", { style: { padding: "16px", fontSize: "13px", opacity: 0.7 } }, t("loading"));

			const status = data.status || {};
			const groups = data.groups || [];
			const cfg = data.config || {};
			const parseIds = (s) => String(s || "").split(/[\s,，;；]+/).map((x) => x.trim()).filter(Boolean);
			const passiveText = ftext("passiveGroups");
			const passive = new Set(passiveText ? parseIds(passiveText) : (cfg.passiveGroups || []));
			const choices = state.sessionChoices || [];
			const shell = state.shell || state;
			const stateLabel = status.online ? t("online") : status.state === "connecting" ? t("connecting") : t("offline");

			const togglePassive = (gid, on) => {
				const next = new Set(passive);
				if (on) next.add(String(gid)); else next.delete(String(gid));
				props.edit("passiveGroups", Array.from(next).join("\n"));
			};

			return h("div", { style: S.wrap },
				h("div", null,
					h("div", { style: S.h1 }, t("title")),
					h("div", { style: S.sub }, t("desc"))),

				h("div", { style: { ...S.box, flexDirection: "row", alignItems: "center" } },
					h("span", { style: S.dot(status.online) }),
					h("span", { style: { fontSize: "13px" } }, stateLabel),
					status.selfId ? h("span", { style: { fontSize: "12px", opacity: 0.7 } }, String(status.selfId)) : null,
					status.nickname ? h("span", { style: { fontSize: "12px", opacity: 0.7 } }, status.nickname) : null,
					h("span", { style: { flex: 1 } }),
					h("button", { style: S.btn, disabled: busy, onClick: () => post("/connect") }, t("connect")),
					h("button", { style: S.btn, disabled: busy, onClick: () => post("/disconnect") }, t("disconnect"))),

				msg ? h("div", { style: { fontSize: "12px", color: "#d9534f" } }, msg) : null,

				h("div", { style: S.box },
					h("div", { style: S.h2 }, t("connTitle")),
					h("div", { style: S.sub }, t("connHint")),
					field({ label: t("fBaseUrl"), hint: t("fBaseUrlHint") },
						h("input", { style: S.input, value: baseUrl, placeholder: "ws://127.0.0.1:3001", onChange: (e) => setBaseUrl(e.target.value) })),
					field({ label: t("fToken"), hint: t("fTokenHint") },
						h("input", { style: S.input, type: "password", value: token, placeholder: status.hasToken ? "••••••" : "", onChange: (e) => setToken(e.target.value) })),
					h("div", { style: { ...S.row, marginTop: "4px" } },
						h("button", { style: S.primary, disabled: busy, onClick: () => {
							const patch = {};
							if (baseUrl) patch.baseUrl = baseUrl;
							if (token) patch.accessToken = token;
							post("/save-conn", patch);
						} }, t("save"))),
					h("label", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "6px 0", fontSize: "13px", cursor: "pointer" } },
						h("span", null, t("fEnabled")),
						h(primitives.Switch, { checked: isOn("enabled"), onChange: (v) => props.edit("enabled", v ? "true" : "false") }))),

				h("div", { style: S.box },
					h("div", { style: { ...S.row, justifyContent: "space-between" } },
						h("span", { style: S.h2 }, t("groupsTitle")),
						h("button", { style: S.btn, onClick: load }, t("refresh"))),
					h("div", { style: S.sub }, t("groupsHint")),
					groups.length === 0
						? h("div", { style: S.sub }, t("groupsEmpty"))
						: h("div", { style: { maxHeight: "220px", overflowY: "auto" } },
							groups.map((g) => h("label", { key: g.groupId, style: { display: "flex", alignItems: "center", gap: "8px", padding: "3px 0", fontSize: "13px", cursor: "pointer" } },
								h(primitives.Switch, { checked: passive.has(String(g.groupId)), onChange: (v) => togglePassive(g.groupId, v) }),
								h("span", { style: { flex: 1 } }, (g.groupName || g.groupId) + "（" + g.groupId + "）"),
								g.lastMessage ? h("span", { style: { fontSize: "11px", opacity: 0.5, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, g.lastMessage.text) : null)))),

				h("div", { style: S.box },
					h("div", { style: S.h2 }, t("targetTitle")),
					h("div", { style: S.sub }, t("targetHint")),
					h("select", { style: S.input, value: ftext("targetSession"), onChange: (e) => props.edit("targetSession", e.target.value) },
						h("option", { value: "" }, t("targetNone")),
						choices.map((s) => h("option", { key: s.id, value: s.id }, (s.title || s.id) + (s.running ? " ●" : ""))))),

				h("div", { style: S.box },
					h("div", { style: S.h2 }, t("permTitle")),
					[["allowSend", t("permSend")], ["allowSticker", t("permSticker")], ["allowActiveRead", t("permRead")]].map((pair) =>
						h("label", { key: pair[0], style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "6px 0", fontSize: "13px", cursor: "pointer" } },
							h("span", null, pair[1]),
							h(primitives.Switch, { checked: isOn(pair[0]), onChange: (v) => props.edit(pair[0], v ? "true" : "false") }))),
					h("div", { style: { ...S.row, marginTop: "6px" } },
						h("button", { style: S.primary, disabled: shell.saving === true || shell.writable === false, onClick: () => props.save() }, shell.saving ? t("saving") : t("save")))));
		}

		class Controller {
			constructor(scope, sessions, workspaces) {
				this.sessions = sessions;
				this.workspaces = workspaces;
				this.FIELDS = ["enabled", "passiveGroups", "targetSession", "allowSend", "allowSticker", "allowActiveRead"];
				this.form = new primitives.SettingsFormModel(scope, this.FIELDS.map((k) => primitives.settingsTextField(k)));
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				const out = Object.assign({}, this.form.shell());
				const fields = {};
				for (const k of this.FIELDS) {
					const f = this.form.field(k);
					fields[k] = f;
					out[k] = f;
				}
				out.fields = fields;
				out.sessionChoices = this.sessionChoices();
				return out;
			}
			sessionChoices() {
				const archived = new Set();
				try { const ws = this.workspaces?.list?.getSnapshot?.() || {}; for (const id of ws.archivedSessionIds || []) archived.add(id); } catch (e) {}
				try {
					const snapshot = this.sessions.list.getSnapshot();
					const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(snapshot.byId || {});
					const rows = [];
					for (const id of ids) {
						const row = (snapshot.byId || {})[id] || {};
						if (row.blank === true) continue;
						if (row.origin === "subagent" || row.origin === "fork") continue;
						if (row.parentId !== undefined && row.parentId !== null && row.parentId !== "") continue;
						if (archived.has(String(row.id || id))) continue;
						const title = typeof row.title === "string" ? row.title.trim() : "";
						if (/^<system-reminder>/i.test(title)) continue;
						rows.push({ id: String(row.id || id), title: title, running: row.running === true });
					}
					rows.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || a.title.localeCompare(b.title));
					return rows;
				} catch (e) { return []; }
			}
			refresh() { this.form.publish(); }
			inject() { return Object.assign({ hooks: { onebotCard: this.store } }, this.form.actions()); }
			dispose() { this.form.dispose(); }
		}

		const inject = ["slots", "locale", "configForms", "sessions", "workspaces"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "ui-onebot-connector: dictionaries");
			const card = new Controller(ctx.configForms.get("onebot-connector"), ctx.sessions, ctx.workspaces);
			ctx.effect(() => () => { card.dispose(); }, "ui-onebot-connector: form subscription");
			ctx.effect(() => {
				const a = ctx.sessions.list.subscribe(() => card.refresh());
				const b = (ctx.workspaces && ctx.workspaces.list && ctx.workspaces.list.subscribe) ? ctx.workspaces.list.subscribe(() => card.refresh()) : (() => {});
				return () => { a(); b(); };
			}, "ui-onebot-connector: session list");
			ctx.effect(() => ctx.configForms.whileServed(["onebot-connector"], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-onebot-connector",
				locale: NS,
				inject: () => card.inject(),
			}, Card))), "ui-onebot-connector: page");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
