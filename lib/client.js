window.__ModuleLoader__.load({
	id: "dsh-onebot-connector",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// 官方组件 —— 带完整样式与动画，不要自己手搓 button/input
		const Button = primitives.Button;
		const Checkbox = primitives.Checkbox;
		const Switch = primitives.Switch;
		const StateDot = primitives.StateDot;
		const Toast = primitives.Toast;
		const SettingsValueField = primitives.SettingsValueField;
		const SettingsSecretField = primitives.SettingsSecretField;

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
			hasToken: "已配置",
			noToken: "未配置",
			connect: "连接",
			disconnect: "断开",
			reconnect: "重新连接",
			online: "在线",
			offline: "离线",
			connecting: "连接中",
			failed: "连接失败",
			disabledState: "未启用",
			fEnabled: "启用连接",
			fEnabledHint: "与 DSH 生命周期一致：启用即连接，禁用或退出 DSH 即断开。",
			groupsTitle: "群列表",
			groupsHint: "勾选 = 被动监听（收到消息就推送）。其它群只缓存，模型要主动读才知道。",
			groupsEmpty: "没有群，或还没连上。",
			connected: "已连接",
			disconnected: "已断开",
			savedConn: "连接信息已保存",
			savedPerm: "权限已保存",
			refresh: "刷新",
			refreshed: "群列表已刷新",
			targetTitle: "推送目标",
			targetHint: "选一个会话当「我家的鱼」。",
			targetNone: "（不推送）",
			permTitle: "权限",
			permSend: "允许主动发消息",
			permSticker: "允许发表情包",
			permRead: "允许主动读取群",
			save: "保存",
			saving: "保存中…",
			loading: "加载中…",
			selectAll: "全选",
			clearAll: "清空",
			selectedCountPrefix: "已选",
			selectedCountSuffix: "个群",
			opFailed: "操作失败",
			noChanges: "没有修改",
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
			hasToken: "configured",
			noToken: "not set",
			connect: "Connect",
			disconnect: "Disconnect",
			reconnect: "Reconnect",
			online: "Online",
			offline: "Offline",
			connecting: "Connecting",
			failed: "Failed",
			disabledState: "Disabled",
			fEnabled: "Enable connection",
			fEnabledHint: "Tied to the DSH lifecycle: enabling connects, disabling or quitting DSH disconnects.",
			groupsTitle: "Groups",
			groupsHint: "Checked = passive listening. Others are cached only.",
			groupsEmpty: "No groups, or not connected yet.",
			connected: "Connected",
			disconnected: "Disconnected",
			savedConn: "Connection saved",
			savedPerm: "Permissions saved",
			refresh: "Refresh",
			refreshed: "Groups refreshed",
			targetTitle: "Push target",
			targetHint: "Pick the session acting as your fish.",
			targetNone: "(do not push)",
			permTitle: "Permissions",
			permSend: "Allow sending",
			permSticker: "Allow stickers",
			permRead: "Allow active reading",
			save: "Save",
			saving: "Saving…",
			loading: "Loading…",
			selectAll: "All",
			clearAll: "None",
			selectedCountPrefix: "Selected",
			selectedCountSuffix: "groups",
			opFailed: "Operation failed",
			noChanges: "No changes",
		};

		// 只用布局，不用来模拟组件外观
		const L = {
			wrap: { display: "flex", flexDirection: "column", gap: "16px", padding: "4px 0" },
			head: { display: "flex", flexDirection: "column", gap: "4px" },
			h1: { fontSize: "17px", fontWeight: 600, margin: 0 },
			h2: { fontSize: "13px", fontWeight: 600, margin: 0 },
			sub: { fontSize: "12px", opacity: 0.65, lineHeight: 1.55, margin: 0 },
			box: { border: "1px solid rgba(128,128,128,.22)", borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" },
			row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			spread: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
			grow: { flex: 1, minWidth: 0 },
			groupList: { display: "flex", flexDirection: "column", gap: "2px", maxHeight: "260px", overflowY: "auto" },
			groupRow: { display: "flex", alignItems: "center", gap: "10px", padding: "5px 6px", borderRadius: "6px" },
			groupMeta: { fontSize: "11px", opacity: 0.5, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			empty: { fontSize: "12px", opacity: 0.5, padding: "8px 0" },
			select: { padding: "7px 9px", fontSize: "13px", borderRadius: "8px", border: "1px solid rgba(128,128,128,.32)", background: "transparent", color: "inherit", width: "100%", boxSizing: "border-box", cursor: "pointer" },
			label: { fontSize: "12px", fontWeight: 500, opacity: 0.8, margin: 0 },
		};

		function Card(props) {
			const t = props.t || ((k) => (typeof k === "function" ? k(0) : k));
			const useCard = props.useOnebotCard || props.useOneBotCard;
			const state = (typeof useCard === "function" ? useCard((s) => s) : null) || {};
			const fieldOf = (k) => state[k] || (state.fields || {})[k];
			const ftext = (k) => {
				const f = fieldOf(k);
				return (f && (typeof f.text === "string" ? f.text : f.value)) || "";
			};
			const isOn = (k) => String(ftext(k)).trim().toLowerCase() === "true";

			const [data, setData] = React.useState(null);
			const [toast, setToast] = React.useState(null);
			const [busy, setBusy] = React.useState("");
			const [baseUrl, setBaseUrl] = React.useState("");
			const [token, setToken] = React.useState("");
			const [connTouched, setConnTouched] = React.useState(false);

			const notify = (text, tone) => setToast({ text: text, tone: tone || "success" });

			const load = React.useCallback(() => {
				fetch(API + "/state", { cache: "no-store" })
					.then((x) => x.json())
					.then((r) => { if (r && r.ok) setData(r); })
					.catch(() => {});
			}, []);

			React.useEffect(() => {
				load();
				const tm = setInterval(load, 3000);
				return () => clearInterval(tm);
			}, [load]);

			const post = React.useCallback((path, body) => {
				setBusy(path);
				return fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
					.then((x) => x.json())
					.then((r) => { load(); return r || { ok: false }; })
					.catch((e) => ({ ok: false, message: String((e && e.message) || e) }))
					.finally(() => setBusy(""));
			}, [load]);

			if (!data) return h("div", { style: { padding: "16px", fontSize: "13px", opacity: 0.6 } }, t("loading"));

			const status = data.status || {};
			const groups = data.groups || [];
			const cfg = data.config || {};
			const choices = state.sessionChoices || [];
			const shell = state.shell || state;

			const parseIds = (s) => String(s || "").split(/[\s,，;；]+/).map((x) => x.trim()).filter(Boolean);
			const passiveText = ftext("passiveGroups");
			const passive = new Set(passiveText ? parseIds(passiveText) : (cfg.passiveGroups || []));

			const dotState = status.online ? "done"
				: status.state === "connecting" ? "ongoing"
				: status.state === "failed" ? "error"
				: "idle";
			const stateLabel = status.online ? t("online")
				: status.state === "connecting" ? t("connecting")
				: status.state === "failed" ? t("failed")
				: status.state === "disabled" ? t("disabledState")
				: t("offline");

			const togglePassive = (gid, on) => {
				const next = new Set(passive);
				if (on) next.add(String(gid)); else next.delete(String(gid));
				props.edit("passiveGroups", Array.from(next).join("\n"));
			};

			const saveConn = () => {
				const patch = {};
				if (baseUrl) patch.baseUrl = baseUrl;
				if (token) patch.accessToken = token;
				if (!Object.keys(patch).length) { notify(t("noChanges"), "warning"); return; }
				post("/save-conn", patch).then((r) => {
					if (r.ok) { notify(t("savedConn"), "success"); setBaseUrl(""); setToken(""); setConnTouched(false); }
					else notify((r.message || t("opFailed")), "error");
				});
			};

			const currentBaseUrl = connTouched ? baseUrl : (status.baseUrl || "");
			const hasToken = status.hasToken === true;

			return h("div", { style: L.wrap },
				toast ? h(Toast, { text: toast.text, tone: toast.tone, onDone: () => setToast(null) }) : null,

				h("div", { style: L.head },
					h("h2", { style: L.h1 }, t("title")),
					h("p", { style: L.sub }, t("desc"))),

				// ── 状态 + 连接控制 ─────────────────────────────
				h("div", { style: Object.assign({}, L.box, { gap: "12px" }) },
					h("div", { style: L.spread },
						h("div", { style: Object.assign({}, L.row, { gap: "8px" }) },
							h(StateDot, { state: dotState }),
							h("span", { style: { fontSize: "13px", fontWeight: 500 } }, stateLabel),
							status.selfId ? h("span", { style: { fontSize: "12px", opacity: 0.6 } }, String(status.selfId) + (status.nickname ? " · " + status.nickname : "")) : null,
							groups.length ? h("span", { style: { fontSize: "12px", opacity: 0.5 } }, "· " + groups.length + " 群") : null),
						h("div", { style: L.row },
							status.online
								? h(Button, { variant: "outline", size: "sm", disabled: busy === "/disconnect", onClick: () => {
										post("/disconnect").then((r) => { if (r.ok) notify(t("disconnected"), "success"); else notify(r.message || t("opFailed"), "error"); });
									} }, t("disconnect"))
								: h(Button, { variant: "primary", size: "sm", disabled: busy === "/connect", onClick: () => {
										post("/connect").then((r) => { if (r.ok) notify(t("connected"), "success"); else notify(r.message || t("opFailed"), "error"); });
									} }, busy === "/connect" ? t("connecting") : t("connect"))))),

				// ── 连接配置 ─────────────────────────────────────
				h("div", { style: L.box },
					h("h3", { style: L.h2 }, t("connTitle")),
					h(SettingsValueField, {
						id: "onebot-base-url",
						label: t("fBaseUrl"),
						hint: t("fBaseUrlHint"),
						text: currentBaseUrl,
						placeholder: "ws://127.0.0.1:3001",
						disabled: busy === "/save-conn",
						onEdit: (v) => { setConnTouched(true); setBaseUrl(v); },
					}),
					h(SettingsSecretField, {
						id: "onebot-access-token",
						label: t("fToken"),
						configured: hasToken,
						stateLabel: hasToken ? t("hasToken") : t("noToken"),
						text: token,
						hint: t("fTokenHint"),
						disabled: busy === "/save-conn",
						onEdit: (v) => { setToken(v); setConnTouched(true); },
					}),
					h("div", { style: L.spread },
						h(Button, { variant: "primary", size: "sm", disabled: busy === "/save-conn" || (!connTouched && !hasToken), onClick: saveConn },
							busy === "/save-conn" ? t("saving") : t("save")),
						h("div", { style: Object.assign({}, L.row, { gap: "8px" }) },
							h("span", { style: { fontSize: "12px", opacity: 0.75 } }, t("fEnabled")),
							h(Switch, { checked: isOn("enabled"), onChange: (v) => props.edit("enabled", v ? "true" : "false") }))),
					h("p", { style: L.sub }, t("fEnabledHint"))),

				// ── 群列表 ───────────────────────────────────────
				h("div", { style: L.box },
					h("div", { style: L.spread },
						h("h3", { style: L.h2 }, t("groupsTitle")),
						h("div", { style: L.row },
							groups.length ? h("span", { style: { fontSize: "11px", opacity: 0.55 } }, t("selectedCountPrefix") + " " + passive.size + " " + t("selectedCountSuffix")) : null,
							groups.length ? h(Button, { variant: "ghost", size: "sm", onClick: () => {
									const all = groups.map((g) => String(g.groupId));
									props.edit("passiveGroups", all.join("\n"));
									notify(t("selectAll"), "success");
								} }, t("selectAll")) : null,
							groups.length ? h(Button, { variant: "ghost", size: "sm", onClick: () => {
									props.edit("passiveGroups", "");
									notify(t("clearAll"), "success");
								} }, t("clearAll")) : null,
							h(Button, { variant: "outline", size: "sm", disabled: busy === "/groups" || !status.online, onClick: () => {
									post("/groups").then(() => notify(t("refreshed"), "success"));
								} }, t("refresh")))),
					h("p", { style: L.sub }, t("groupsHint")),
					groups.length === 0
						? h("div", { style: L.empty }, t("groupsEmpty"))
						: h("div", { style: L.groupList },
							groups.map((g) => h("div", { key: String(g.groupId), style: L.groupRow },
								h(Checkbox, {
									checked: passive.has(String(g.groupId)),
									onChange: (v) => togglePassive(g.groupId, v),
									label: (g.groupName || String(g.groupId)) + "（" + g.groupId + "）" + (g.memberCount ? " · " + g.memberCount + "人" : ""),
								}),
								h("span", { style: L.grow }),
								g.lastMessage ? h("span", { style: L.groupMeta }, g.lastMessage.text) : null)))),

				// ── 推送目标 ─────────────────────────────────────
				h("div", { style: L.box },
					h("h3", { style: L.h2 }, t("targetTitle")),
					h("p", { style: L.sub }, t("targetHint")),
					h("select", {
						style: L.select,
						value: ftext("targetSession"),
						onChange: (e) => props.edit("targetSession", e.target.value),
					},
						h("option", { value: "" }, t("targetNone")),
						choices.map((s) => h("option", { key: s.id, value: s.id }, (s.running ? "● " : "") + (s.title || s.id))))),

				// ── 权限 ─────────────────────────────────────────
				h("div", { style: L.box },
					h("h3", { style: L.h2 }, t("permTitle")),
					[["allowSend", t("permSend")], ["allowSticker", t("permSticker")], ["allowActiveRead", t("permRead")]].map((pair) =>
						h("div", { key: pair[0], style: L.spread },
							h("span", { style: { fontSize: "13px" } }, pair[1]),
							h(Switch, { checked: isOn(pair[0]), onChange: (v) => props.edit(pair[0], v ? "true" : "false") }))),
					h("div", { style: Object.assign({}, L.row, { marginTop: "2px" }) },
						h(Button, { variant: "primary", size: "sm", disabled: shell.saving === true || shell.writable === false, onClick: () => {
								props.save();
								notify(t("savedPerm"), "success");
							} }, shell.saving ? t("saving") : t("save")))));
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
